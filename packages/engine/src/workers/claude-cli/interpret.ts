// The pure stream-json parser of the Claude CLI adapter (0008 sections 1, 3 and 4). The engine
// runs it over `events.ndjson`, live and on replay after a daemon restart, so it never reads a
// clock, a file or a global: everything it knows travels in the returned state.
//
// Usage (0008 section 4): live numbers come from assistant messages, counted once per message
// id (parallel tool calls repeat one id); per-message output is a placeholder, so live output
// stays zero. At each turn end the result's cumulative `modelUsage` replaces the live numbers.
// The CLI's totals are cumulative per process and include restored spend on resume, so the run
// adds only the change since the last totals it saw (`baseline`). A result whose totals are
// empty or zero (a crash, an aborted turn) keeps the live numbers instead: the DIPO-41 recording
// `pause-now` shows the CLI's next totals leave an aborted turn's spend out.

import type {
  HostLine,
  ModelUsageTotals,
  UsageTotalsByModel,
  WorkerEvent,
  WorkerReport,
} from "../types";
import { WorkerReportSchema } from "./report-schema";
import {
  ApiRetryMessage,
  AssistantMessage,
  CompactBoundaryMessage,
  HookPayload,
  InitMessage,
  KNOWN_SYSTEM_SUBTYPES,
  KNOWN_TYPES,
  ModelUsageEntry,
  PermissionDeniedMessage,
  RateLimitMessage,
  ResultMessage,
  SessionStateMessage,
  TextBlock,
  ToolUseBlock,
} from "./schema";
import type { z } from "zod";

/** The tool through which `--json-schema` returns the report; not worker activity. */
export const REPORT_TOOL = "StructuredOutput";
/** Tools that start a subagent. */
export const SUBAGENT_TOOLS: readonly string[] = ["Agent", "Task"];
/** Assistant `error` values that mean the login or the account cannot run (0008 section 7). */
export const START_FAILURE_ERRORS: readonly string[] = [
  "authentication_failed",
  "billing_error",
  "account_on_hold",
];
/** Model aliases `--model` accepts (0008 section 2). */
const MODEL_ALIASES: readonly string[] = ["haiku", "sonnet", "opus", "fable"];

/** What the last `result` of the run said. */
export interface TurnRecord {
  readonly subtype: string;
  readonly terminal: string;
  readonly report: WorkerReport | null;
  /** Why the report is missing or invalid, when `report` is null. */
  readonly reportProblem: string | null;
  readonly numTurns: number;
  readonly startupFailure: string | null;
  readonly apiErrorStatus: number | null;
}

/** The Claude CLI adapter's parse state; plain JSON, so the engine can store it. */
export interface ClaudeParseState {
  /** Stdout text after the last newline, held until the line completes. */
  readonly pending: string;
  /** A partial line was still held when the process exited. */
  readonly truncated: boolean;
  readonly sessionId: string | null;
  readonly version: string | null;
  /** The model of the current process's first `system/init`. */
  readonly model: string | null;
  /** True once this process emitted `started`; `system/init` repeats on every turn. */
  readonly started: boolean;
  /** Planned model (alias or id) and recorded classifier switches; null skips the check. */
  readonly plannedModel: string | null;
  readonly acceptedModels: readonly string[];
  /** Why `system/init` failed its checks (0008 section 2), or null. */
  readonly initRejected: string | null;
  /** Message ids already counted. */
  readonly seen: readonly string[];
  /** Live numbers since the last turn end, per model. */
  readonly live: UsageTotalsByModel;
  /** Run totals as of the last turn end, per model. */
  readonly committed: UsageTotalsByModel;
  /** The CLI's cumulative totals at the last turn end. */
  readonly baseline: UsageTotalsByModel;
  /** Models seen in `system/init` or `modelUsage`, first one first. */
  readonly models: readonly string[];
  /** Tool use ids already reported as `denied`. */
  readonly denied: readonly string[];
  readonly lastTurn: TurnRecord | null;
  /** Set once a turn ends `error_max_turns`; the backstop fired (0008 section 7). */
  readonly capped: string | null;
  /** A start failure: `startup_failure_reason` or an account error. */
  readonly startFailure: string | null;
  /** A plan limit stopped the run: `rejected`, `credits_required`, or a 429. */
  readonly planLimit: string | null;
  /** The last assistant `error` value, for a crash detail. */
  readonly lastError: string | null;
  /** Process exits seen as `exit` lines. */
  readonly exits: number;
  /** Message types (`type` or `system/<subtype>`) not known to the adapter, first sighting order. */
  readonly unknownTypes: readonly string[];
  /** Known lines that failed their schema or did not parse, with a short reason. */
  readonly problems: readonly string[];
}

export interface InitialStateOptions {
  /** The planned `--model`, alias or full id; when set, `system/init` must match it. */
  readonly plannedModel?: string;
  /** Classifier switches already recorded on the run (0008 open question 7). */
  readonly acceptedModels?: readonly string[];
  /** Totals the run starts from, for a resumed run. */
  readonly totals?: UsageTotalsByModel;
  /** The CLI totals stored at the last turn end, for a resumed session; defaults to `totals`. */
  readonly baseline?: UsageTotalsByModel;
}

export function initialState(options: InitialStateOptions = {}): ClaudeParseState {
  const totals = options.totals ?? {};
  return {
    pending: "",
    truncated: false,
    sessionId: null,
    version: null,
    model: null,
    started: false,
    plannedModel: options.plannedModel ?? null,
    acceptedModels: options.acceptedModels ?? [],
    initRejected: null,
    seen: [],
    live: {},
    committed: totals,
    baseline: options.baseline ?? totals,
    models: [],
    denied: [],
    lastTurn: null,
    capped: null,
    startFailure: null,
    planLimit: null,
    lastError: null,
    exits: 0,
    unknownTypes: [],
    problems: [],
  };
}

// ---- usage arithmetic ------------------------------------------------------------------------

export const ZERO_USAGE: ModelUsageTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
const FIELDS = ["input", "output", "cacheCreate", "cacheRead"] as const;

function add(a: ModelUsageTotals, b: ModelUsageTotals): ModelUsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

/** Per-model sum of two totals. */
export function addTotals(a: UsageTotalsByModel, b: UsageTotalsByModel): UsageTotalsByModel {
  const out: Record<string, ModelUsageTotals> = { ...a };
  for (const [model, usage] of Object.entries(b)) out[model] = add(out[model] ?? ZERO_USAGE, usage);
  return out;
}

function isZero(usage: ModelUsageTotals): boolean {
  return FIELDS.every((field) => usage[field] === 0);
}

/**
 * The change from `before` to `now` for one model. When any field went down, the CLI's count
 * restarted (a session without restored totals), so all of `now` is new.
 */
function delta(now: ModelUsageTotals, before: ModelUsageTotals): ModelUsageTotals {
  if (FIELDS.some((field) => now[field] < before[field])) return now;
  return {
    input: now.input - before.input,
    output: now.output - before.output,
    cacheCreate: now.cacheCreate - before.cacheCreate,
    cacheRead: now.cacheRead - before.cacheRead,
  };
}

/** Per field the larger of two totals. */
function larger(a: ModelUsageTotals, b: ModelUsageTotals): ModelUsageTotals {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheCreate: Math.max(a.cacheCreate, b.cacheCreate),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
  };
}

function fromModelUsage(entry: z.infer<typeof ModelUsageEntry>): ModelUsageTotals {
  return {
    input: entry.inputTokens,
    output: entry.outputTokens,
    cacheCreate: entry.cacheCreationInputTokens,
    cacheRead: entry.cacheReadInputTokens,
  };
}

/** Run totals now: committed plus live numbers since the last turn end. */
export function currentTotals(state: ClaudeParseState): UsageTotalsByModel {
  return addTotals(state.committed, state.live);
}

/** Budget tokens (0008 section 4): input plus output plus cache creation, over every model. */
export function budgetTokens(totals: UsageTotalsByModel): number {
  let sum = 0;
  for (const usage of Object.values(totals)) sum += usage.input + usage.output + usage.cacheCreate;
  return sum;
}

// ---- line handling ---------------------------------------------------------------------------

type Step = { events: WorkerEvent[]; state: ClaudeParseState };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remember(list: readonly string[], item: string): readonly string[] {
  return list.includes(item) ? list : [...list, item];
}

function problem(state: ClaudeParseState, text: string): ClaudeParseState {
  return { ...state, problems: [...state.problems, text] };
}

/** Pure: one host line to Worker events (0008 section 3). */
export function interpret(line: HostLine, state: ClaudeParseState): Step {
  switch (line.ch) {
    case "stdout":
      return stdoutText(line.data, state);
    case "hook":
      return hookLine(line.data, state);
    case "exit":
      return {
        events: [],
        state: {
          ...state,
          pending: "",
          truncated: state.truncated || state.pending !== "",
          started: false,
          model: null,
          exits: state.exits + 1,
        },
      };
    default:
      // stderr is redacted in recordings and never decides anything.
      return { events: [], state };
  }
}

/** Splits stdout text into complete lines, holding a partial last line until it completes. */
function stdoutText(data: string, state: ClaudeParseState): Step {
  const text = state.pending + data;
  const parts = text.split("\n");
  const tail = parts.pop() ?? "";
  let step: Step = { events: [], state: { ...state, pending: "" } };
  for (const part of parts) {
    if (part.trim() === "") continue;
    step = merge(step, completeLine(part, step.state));
  }
  if (tail.trim() !== "") {
    // A host may hand over a line without its newline; a complete JSON value is a whole line.
    const parsed = tryParse(tail);
    if (parsed.ok) step = merge(step, message(parsed.value, step.state));
    else step = { events: step.events, state: { ...step.state, pending: tail } };
  }
  return step;
}

function merge(first: Step, next: Step): Step {
  return { events: [...first.events, ...next.events], state: next.state };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function completeLine(text: string, state: ClaudeParseState): Step {
  const parsed = tryParse(text);
  if (!parsed.ok) return { events: [], state: problem(state, "unparseable stdout line") };
  return message(parsed.value, state);
}

function kindOf(value: Record<string, unknown>): string {
  const type = typeof value["type"] === "string" ? value["type"] : "?";
  return type === "system" && typeof value["subtype"] === "string"
    ? `system/${value["subtype"]}`
    : type;
}

function isKnown(value: Record<string, unknown>): boolean {
  const type = value["type"];
  if (!(KNOWN_TYPES as readonly unknown[]).includes(type)) return false;
  return (
    type !== "system" || (KNOWN_SYSTEM_SUBTYPES as readonly unknown[]).includes(value["subtype"])
  );
}

function parseWith<T>(
  schema: z.ZodType<T>,
  value: unknown,
  state: ClaudeParseState,
): { ok: true; value: T } | { ok: false; state: ClaudeParseState } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const kind = isRecord(value) ? kindOf(value) : "?";
  const path = parsed.error.issues[0]?.path.join(".") ?? "";
  return { ok: false, state: problem(state, `${kind} failed its schema at ${path || "(root)"}`) };
}

/** One stream-json object. */
export function message(value: unknown, state: ClaudeParseState): Step {
  if (!isRecord(value))
    return { events: [], state: problem(state, "stdout line is not an object") };
  if (!isKnown(value)) {
    return {
      events: [],
      state: { ...state, unknownTypes: remember(state.unknownTypes, kindOf(value)) },
    };
  }
  switch (kindOf(value)) {
    case "system/init":
      return init(value, state);
    case "assistant":
      return assistant(value, state);
    case "result":
      return result(value, state);
    case "system/permission_denied": {
      const parsed = parseWith(PermissionDeniedMessage, value, state);
      if (!parsed.ok) return { events: [], state: parsed.state };
      return denial(
        state,
        parsed.value.tool_use_id,
        parsed.value.tool_name,
        parsed.value.decision_reason_type ?? "permission_denied",
      );
    }
    case "rate_limit_event":
      return rateLimit(value, state);
    case "system/api_retry": {
      const parsed = parseWith(ApiRetryMessage, value, state);
      if (!parsed.ok) return { events: [], state: parsed.state };
      if (parsed.value.error === "rate_limit") {
        return {
          events: [
            { t: "limit", status: "rate_limit" },
            { t: "waiting", on: "plan-limit", detail: "api_retry rate_limit" },
          ],
          state,
        };
      }
      return {
        events: [{ t: "waiting", on: "retry", detail: `api_retry ${parsed.value.error}` }],
        state,
      };
    }
    case "system/compact_boundary": {
      const parsed = parseWith(CompactBoundaryMessage, value, state);
      if (!parsed.ok) return { events: [], state: parsed.state };
      return {
        events: [{ t: "compacted", preTokens: parsed.value.compact_metadata.pre_tokens }],
        state,
      };
    }
    case "system/session_state_changed": {
      const parsed = parseWith(SessionStateMessage, value, state);
      if (!parsed.ok) return { events: [], state: parsed.state };
      // Secondary signal of a permission wait (0008 section 3); idle and running are liveness.
      return parsed.value.state === "requires_action"
        ? { events: [{ t: "waiting", on: "permission", detail: "requires_action" }], state }
        : { events: [], state };
    }
    default:
      // Known, read for liveness only: stream events, user turns, status, task and hook progress.
      return { events: [], state };
  }
}

function modelMatches(planned: string, actual: string): boolean {
  if (planned === actual) return true;
  return MODEL_ALIASES.includes(planned) && actual.startsWith(`claude-${planned}-`);
}

function init(value: unknown, state: ClaudeParseState): Step {
  const parsed = parseWith(InitMessage, value, state);
  if (!parsed.ok) return { events: [], state: parsed.state };
  const msg = parsed.value;
  const events: WorkerEvent[] = [];
  let next: ClaudeParseState = {
    ...state,
    sessionId: msg.session_id,
    version: msg.claude_code_version,
  };

  // 0008 section 2: no API key, and the planned model or a recorded classifier switch.
  if (next.initRejected === null) {
    if (msg.apiKeySource !== "none") {
      next = { ...next, initRejected: `apiKeySource is ${msg.apiKeySource}, not none` };
    } else if (
      next.plannedModel !== null &&
      !modelMatches(next.plannedModel, msg.model) &&
      !next.acceptedModels.includes(msg.model)
    ) {
      next = {
        ...next,
        initRejected: `model ${msg.model} is not the planned ${next.plannedModel}`,
      };
    }
    // A neutral event, so the engine can stop the worker before it does anything (DIPO-45).
    if (next.initRejected !== null) events.push({ t: "initRejected", reason: next.initRejected });
  }

  if (!next.started) {
    events.push({
      t: "started",
      sessionId: msg.session_id,
      model: msg.model,
      version: msg.claude_code_version,
      permissionMode: msg.permissionMode,
      tools: [...msg.tools],
    });
    next = { ...next, started: true, model: msg.model };
  } else if (next.model !== null && next.model !== msg.model) {
    events.push({ t: "modelSwitched", from: next.model, to: msg.model });
    next = { ...next, model: msg.model };
  }
  return { events, state: { ...next, models: remember(next.models, msg.model) } };
}

function toolPath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function assistant(value: unknown, state: ClaudeParseState): Step {
  const parsed = parseWith(AssistantMessage, value, state);
  if (!parsed.ok) return { events: [], state: parsed.state };
  const msg = parsed.value;
  const agentId = msg.parent_tool_use_id ?? undefined;
  const scope = agentId === undefined ? {} : { agentId };
  const events: WorkerEvent[] = [];
  let next = state;

  for (const raw of msg.message.content) {
    const text = TextBlock.safeParse(raw);
    if (text.success) {
      events.push({ t: "activity", kind: "text", ...scope });
      // Only the main agent's words feed `work.output`; subagent work shows as activity.
      if (agentId === undefined) events.push({ t: "output", text: text.data.text });
      continue;
    }
    const tool = ToolUseBlock.safeParse(raw);
    if (!tool.success || tool.data.name === REPORT_TOOL) continue;
    if (SUBAGENT_TOOLS.includes(tool.data.name)) {
      events.push({ t: "activity", kind: "subagent", tool: tool.data.name, agentId: tool.data.id });
    } else {
      const path = toolPath(tool.data.input);
      events.push({
        t: "activity",
        kind: "tool",
        tool: tool.data.name,
        ...(path === undefined ? {} : { path }),
        ...scope,
      });
    }
  }

  // Usage once per message id; the parent tool use names the subagent.
  if (!next.seen.includes(msg.message.id)) {
    const usage = msg.message.usage;
    const counted: ModelUsageTotals = {
      input: usage.input_tokens,
      output: 0,
      cacheCreate: usage.cache_creation_input_tokens,
      cacheRead: usage.cache_read_input_tokens,
    };
    events.push({
      t: "usage",
      messageId: msg.message.id,
      model: msg.message.model,
      ...scope,
      input: counted.input,
      cacheCreate: counted.cacheCreate,
      cacheRead: counted.cacheRead,
    });
    next = {
      ...next,
      seen: [...next.seen, msg.message.id],
      live: addTotals(next.live, { [msg.message.model]: counted }),
    };
  }

  if (msg.error !== undefined) {
    next = { ...next, lastError: msg.error };
    if (msg.error === "rate_limit") {
      events.push({ t: "limit", status: "rate_limit" });
      events.push({ t: "waiting", on: "plan-limit", detail: "assistant error rate_limit" });
      next = { ...next, planLimit: next.planLimit ?? "assistant error rate_limit" };
    } else if (START_FAILURE_ERRORS.includes(msg.error)) {
      events.push({ t: "waiting", on: "auth", detail: msg.error });
      next = { ...next, startFailure: next.startFailure ?? msg.error };
    }
  }
  return { events, state: next };
}

function denial(state: ClaudeParseState, id: string, tool: string, reason: string): Step {
  if (state.denied.includes(id)) return { events: [], state };
  return {
    events: [{ t: "denied", tool, reason }],
    state: { ...state, denied: [...state.denied, id] },
  };
}

function readReport(output: unknown): { report: WorkerReport | null; problem: string | null } {
  if (output === undefined || output === null)
    return { report: null, problem: "no structured_output" };
  const parsed = WorkerReportSchema.safeParse(output);
  if (!parsed.success)
    return { report: null, problem: "structured_output fails the report schema" };
  return { report: parsed.data, problem: null };
}

function result(value: unknown, state: ClaudeParseState): Step {
  const parsed = parseWith(ResultMessage, value, state);
  if (!parsed.ok) return { events: [], state: parsed.state };
  const msg = parsed.value;
  const events: WorkerEvent[] = [];
  let next: ClaudeParseState = { ...state, sessionId: msg.session_id };

  // Authoritative denials; the best-effort `system/permission_denied` lines came first.
  for (const denied of msg.permission_denials) {
    const step = denial(next, denied.tool_use_id, denied.tool_name, "permission_denials");
    events.push(...step.events);
    next = step.state;
  }

  // Usage: on a completed turn the cumulative totals replace the live numbers. A turn that did
  // not complete (aborted, capped, crashed) may report totals without its own spend, or none at
  // all, so per field the larger of the live numbers and the reported change is kept.
  const reported: Record<string, ModelUsageTotals> = {};
  for (const [model, entry] of Object.entries(msg.modelUsage))
    reported[model] = fromModelUsage(entry);
  const none = Object.values(reported).every(isZero);
  const completed =
    (msg.terminal_reason ?? (msg.subtype === "success" ? "completed" : msg.subtype)) ===
    "completed";
  const change: Record<string, ModelUsageTotals> = {};
  if (!none) {
    for (const [model, usage] of Object.entries(reported)) {
      change[model] = delta(usage, next.baseline[model] ?? ZERO_USAGE);
    }
  }
  if (none || !completed) {
    for (const model of new Set([...Object.keys(change), ...Object.keys(next.live)])) {
      change[model] = larger(change[model] ?? ZERO_USAGE, next.live[model] ?? ZERO_USAGE);
    }
  }
  next = {
    ...next,
    committed: addTotals(next.committed, change),
    live: {},
    baseline: none ? next.baseline : { ...next.baseline, ...reported },
  };
  for (const model of Object.keys(reported)) {
    if (!next.models.includes(model) && next.models.length > 0) {
      events.push({
        t: "modelSwitched",
        from: next.models[next.models.length - 1] ?? model,
        to: model,
      });
    }
    next = { ...next, models: remember(next.models, model) };
  }

  const { report, problem: reportProblem } = readReport(msg.structured_output);
  const terminal = msg.terminal_reason ?? msg.subtype;
  const turn: TurnRecord = {
    subtype: msg.subtype,
    terminal,
    report,
    reportProblem,
    numTurns: msg.num_turns,
    startupFailure: msg.startup_failure_reason ?? null,
    apiErrorStatus: msg.api_error_status ?? null,
  };
  next = { ...next, lastTurn: turn };
  if (msg.subtype === "error_max_turns" && next.capped === null) {
    next = { ...next, capped: `turn cap (--max-turns) after ${msg.num_turns} turns` };
  }
  if (turn.startupFailure !== null && next.startFailure === null) {
    next = { ...next, startFailure: `startup_failure_reason ${turn.startupFailure}` };
  }
  if (turn.apiErrorStatus === 429 && next.planLimit === null) {
    next = { ...next, planLimit: "turn ended by a 429 rate-limit error" };
  }

  events.push({ t: "turn", report, totals: next.committed, numTurns: msg.num_turns, terminal });
  if (
    report?.status === "blocked" &&
    report.question !== undefined &&
    report.needsPermission === undefined
  ) {
    events.push({ t: "waiting", on: "question", detail: report.question });
  }
  return { events, state: next };
}

function epochIso(seconds: number | undefined): string | undefined {
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

function rateLimit(value: unknown, state: ClaudeParseState): Step {
  const parsed = parseWith(RateLimitMessage, value, state);
  if (!parsed.ok) return { events: [], state: parsed.state };
  const info = parsed.value.rate_limit_info;
  const windows = info.unifiedWindows ?? {};
  const window = info.rateLimitType === undefined ? undefined : windows[info.rateLimitType];
  let utilization = info.utilization ?? window?.utilization;
  if (utilization === undefined) {
    const all = Object.values(windows).flatMap((w) =>
      w.utilization === undefined ? [] : [w.utilization],
    );
    if (all.length > 0) utilization = Math.max(...all);
  }
  const resetsAt = epochIso(info.resetsAt);
  const credits = info.errorCode === "credits_required";
  const events: WorkerEvent[] = [
    {
      t: "limit",
      status: info.status,
      ...(utilization === undefined ? {} : { utilization: Math.min(1, utilization) }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(credits ? { creditsRequired: true } : {}),
    },
  ];
  let next = state;
  if (info.status === "rejected" || credits) {
    const detail = credits
      ? "credits_required"
      : `rate limit ${info.rateLimitType ?? "unknown"} rejected`;
    events.push({
      t: "waiting",
      on: "plan-limit",
      detail,
      ...(resetsAt === undefined || credits ? {} : { until: resetsAt }),
    });
    next = { ...next, planLimit: next.planLimit ?? detail };
  }
  return { events, state: next };
}

function hookLine(data: string, state: ClaudeParseState): Step {
  const parsedJson = tryParse(data);
  if (!parsedJson.ok) return { events: [], state: problem(state, "unparseable hook line") };
  const parsed = parseWith(HookPayload, parsedJson.value, state);
  if (!parsed.ok) return { events: [], state: parsed.state };
  const hook = parsed.value;
  switch (hook.hook_event_name) {
    case "PermissionRequest":
      // The primary permission-wait signal (0008 sections 3 and 5).
      return {
        events: [{ t: "waiting", on: "permission", detail: hook.tool_name ?? "PermissionRequest" }],
        state,
      };
    case "StopFailure":
      if (hook.error === "rate_limit") {
        return {
          events: [
            { t: "limit", status: "rate_limit" },
            { t: "waiting", on: "plan-limit", detail: "StopFailure rate_limit" },
          ],
          state: { ...state, planLimit: state.planLimit ?? "StopFailure rate_limit" },
        };
      }
      return { events: [], state };
    default:
      return { events: [], state };
  }
}

/** `interpret` plus a log line for each message type seen for the first time in this run. */
export function interpretLogged(
  line: HostLine,
  state: ClaudeParseState,
  log: (message: string) => void,
): Step {
  const step = interpret(line, state);
  for (const type of step.state.unknownTypes.slice(state.unknownTypes.length)) {
    log(`claude-cli: unknown stream-json message type ${type} ignored`);
  }
  return step;
}
