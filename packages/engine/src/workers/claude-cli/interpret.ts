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
//
// The turn in progress (DIPO-296): a worker session is one turn, one result at its end, so turns
// and output would show 0 for the whole session. `liveUsage` reports what the stream says of the
// turn so far, for the live view only: the main agent's model turns (one at its first message, one
// more for each main-agent `user` line after it, tool results or a message dipo sent mid-turn,
// which is how the result's `num_turns` counts in the recordings) and the final output of each
// main-agent message, from the `message_delta` stream event `--include-partial-messages` sends.
// The turn end replaces both, and the exit sets both to 0.

import type {
  HostLine,
  ModelUsageTotals,
  PlanLimitScope,
  ReportKind,
  ReviewReport,
  StreamDriftKind,
  ToolEffect,
  TurnProblem,
  UsageTotalsByModel,
  WorkerEvent,
  WorkerReport,
} from "../types";
import { WEB_LINE_PREFIX } from "../types";
import { flatInput } from "../../ingest/output";
import { hookEventOf, WEB_TOOLS } from "./hooks";
import { pluginRefusal, refusedPlugins } from "./plugins";
import { CHECKED_CLAUDE_VERSION, compareVersions } from "./probe";
import { parseReviewReport, parseWorkerReport } from "./report-schema";
import { skillRefusal } from "./skills";
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
  StreamMessageDelta,
  StreamMessageStart,
  TextBlock,
  THINKING_BLOCK_TYPES,
  ThinkingTokensMessage,
  ToolUseBlock,
  UserLine,
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
  /** A `review` session's valid report (0019 section 5); absent in other kinds. */
  readonly review?: ReviewReport;
  /** Why the report is missing or invalid, when the kind's report is absent. */
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
  /**
   * `worker.plugins` of the office (DIPO-108): a `system/init` that lists another plugin is a
   * start failure. Absent or null skips the check (states stored before it existed, tests). The
   * run's adapter sets it from the configuration of its launch on every line.
   */
  readonly allowedPlugins?: readonly string[] | null;
  /**
   * The installed and synced plugin ids the launch read (DIPO-108): an `@builtin` id among them is
   * compared like any other plugin, not exempted.
   */
  readonly knownPlugins?: readonly string[];
  /**
   * The plugins of the last `system/init`, as `<plugin>@<marketplace>` (DIPO-108). Absent in states
   * stored before it existed.
   */
  readonly plugins?: readonly string[];
  /**
   * True when the plan passed `--disable-slash-commands` (DIPO-130): a `system/init` that lists
   * any skill is a start failure. Absent or false skips the check (states stored before it existed,
   * recordings captured without the flag). The run's adapter sets it on every line.
   */
  readonly refuseSkills?: boolean;
  /** The skills of the last `system/init` (DIPO-130). Absent in states stored before it existed. */
  readonly skills?: readonly string[];
  /**
   * `review` when the session is a reviewer's (0019 sections 4 and 5): its result carries a
   * `ReviewReport`, and `worker.plugins` does not apply, so `system/init` may list no plugin but the
   * builtin ones. Absent means `implement`, as in states stored before it existed.
   */
  readonly reportKind?: ReportKind;
  /**
   * True for a developer session in a box (DIPO-271): its Claude Code has only the placeholder
   * key of `boxModelEnvironment`, which dipo's model proxy outside the box replaces, so the
   * `system/init` key source is the placeholder's and is not refused. Never for a reviewer, which
   * runs on the Mac with the maintainer's login. The run's adapter sets it on every line.
   */
  readonly placeholderKey?: boolean;
  /** Message ids already counted. */
  readonly seen: readonly string[];
  /** Live numbers since the last turn end, per model. */
  readonly live: UsageTotalsByModel;
  /** Run totals as of the last turn end, per model. */
  readonly committed: UsageTotalsByModel;
  /** The CLI's cumulative totals at the last turn end. */
  readonly baseline: UsageTotalsByModel;
  /**
   * The CLI's `costUSD` per model as run totals at the last turn end, and the CLI's cumulative
   * values it was last seen at (DIPO-62). Absent in states stored before they existed.
   */
  readonly costCommitted?: Readonly<Record<string, number>>;
  readonly costBaseline?: Readonly<Record<string, number>>;
  /**
   * Set once a turn end kept live numbers above the CLI's totals (an aborted or crashed turn):
   * the CLI's cost then leaves counted spend out, and turn events stop carrying it.
   */
  readonly costDrift?: boolean;
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
  /**
   * The CLI totals a resumed session restored (DIPO-51): the previous session's totals at its
   * last turn end. Set only until the first turn end of the resumed session; a field the CLI
   * reports below `baseline` but at or above this floor counts only this session's live numbers.
   * Absent in states stored before it existed and outside a resume.
   */
  readonly restoredFloor?: UsageTotalsByModel;
  /** The CLI cost a resumed session restored, as `restoredFloor` for `costUSD`. */
  readonly costFloor?: Readonly<Record<string, number>>;
  /** Context tokens (input, cache creation, cache read) of the main agent's last request. */
  readonly contextTokens?: number | null;
  /** The main model's context window as the last result reported it. */
  readonly contextWindow?: number | null;
  /**
   * Compactions this process reported through `compact_boundary` and through the `PostCompact`
   * hook (DIPO-59). One compaction shows on both paths in either order, so `compacted` is emitted
   * only when a path's count passes the other's. Absent in states stored before they existed.
   */
  readonly compactBoundaries?: number;
  readonly compactHooks?: number;
  /**
   * Compactions this process already emitted as `compacted` (DIPO-100). A hook that comes first
   * carries no token count, so it waits for its `compact_boundary` and the real `pre_tokens`;
   * only a turn end or the exit reports it, with no `preTokens` (DIPO-106). Absent in states
   * stored before it existed, where every counted compaction was already emitted.
   */
  readonly compactReported?: number;
  /**
   * The CLI's token estimate of the thinking block in progress, from `system/thinking_tokens`
   * (DIPO-96); cleared when the block's assistant line reports it, and at the exit. A number only:
   * the parser never keeps thinking text. Absent in states stored before it existed.
   */
  readonly thinkingTokens?: number;
  /**
   * The main agent's model turns of the turn in progress (DIPO-296): one at its first message, one
   * more per main-agent `user` line after it. Cleared at the turn end and the exit; absent in
   * states stored before it existed.
   */
  readonly liveTurns?: number;
  /** The output of the turn in progress that `message_delta` stream events reported (DIPO-296). */
  readonly liveOutput?: number;
  /** The main-agent message the stream sends now, and the output already counted of it. */
  readonly streaming?: { readonly id: string; readonly counted: number };
}

export interface InitialStateOptions {
  /** The planned `--model`, alias or full id; when set, `system/init` must match it. */
  readonly plannedModel?: string;
  /** `worker.plugins`; when set, `system/init` may list no other plugin (DIPO-108). */
  readonly allowedPlugins?: readonly string[];
  /** The installed and synced plugin ids of the launch (DIPO-108). */
  readonly knownPlugins?: readonly string[];
  /** True when `system/init` may list no skill (DIPO-130). */
  readonly refuseSkills?: boolean;
  /** `review` for a reviewer session (0019 section 5); `implement` by default. */
  readonly reportKind?: ReportKind;
  /** Classifier switches already recorded on the run (0008 open question 7). */
  readonly acceptedModels?: readonly string[];
  /** Totals the run starts from, for a resumed run. */
  readonly totals?: UsageTotalsByModel;
  /** The CLI totals stored at the last turn end, for a resumed session; defaults to `totals`. */
  readonly baseline?: UsageTotalsByModel;
  /** The CLI cost in USD per model the run starts from, for a resumed run. */
  readonly costUsd?: Readonly<Record<string, number>>;
  /** The CLI cost stored at the last turn end, for a resumed session; defaults to `costUsd`. */
  readonly costBaseline?: Readonly<Record<string, number>>;
  /** The CLI totals a resumed session restores (DIPO-51); see `ClaudeParseState.restoredFloor`. */
  readonly restoredFloor?: UsageTotalsByModel;
  /** The CLI cost a resumed session restores. */
  readonly costFloor?: Readonly<Record<string, number>>;
}

/**
 * The options of the next session of a run from the previous session's stored state (DIPO-51):
 * the recorded classifier switches always carry over. A `resume` continues the CLI's counts, so
 * the new agent starts with no totals of its own, a baseline of what the previous process had
 * counted (its last turn totals plus the live numbers after them), and the previous turn totals
 * as the restored floor; a new session's counts start at zero.
 */
export function nextSessionOptions(
  previous: ClaudeParseState,
  resume: boolean,
  plannedModel: string,
): InitialStateOptions {
  const accepted = { plannedModel, acceptedModels: [...(previous.acceptedModels ?? [])] };
  if (!resume) return accepted;
  return {
    ...accepted,
    totals: {},
    baseline: addTotals(previous.baseline ?? {}, previous.live ?? {}),
    restoredFloor: previous.baseline ?? {},
    costUsd: {},
    costBaseline: previous.costBaseline ?? {},
    costFloor: previous.costBaseline ?? {},
  };
}

export function initialState(options: InitialStateOptions = {}): ClaudeParseState {
  const totals = options.totals ?? {};
  return {
    ...(options.restoredFloor === undefined ? {} : { restoredFloor: options.restoredFloor }),
    ...(options.allowedPlugins === undefined ? {} : { allowedPlugins: options.allowedPlugins }),
    ...(options.knownPlugins === undefined ? {} : { knownPlugins: options.knownPlugins }),
    ...(options.refuseSkills === undefined ? {} : { refuseSkills: options.refuseSkills }),
    ...(options.reportKind === undefined || options.reportKind === "implement"
      ? {}
      : { reportKind: options.reportKind }),
    ...(options.costFloor === undefined ? {} : { costFloor: options.costFloor }),
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
    costCommitted: options.costUsd ?? {},
    costBaseline: options.costBaseline ?? options.costUsd ?? {},
    costDrift: false,
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

/**
 * The change at the first turn end of a resumed session (DIPO-51), per field: at or above the
 * baseline (what the previous process had counted) the rise is new, but at least this session's
 * live numbers, since a CLI that restored only the floor reaches the baseline with less new
 * spend than it shows; between the restored floor and the baseline the CLI restored less than
 * was counted, so only this session's live numbers are new; below the floor the CLI's count
 * restarted, so all of it is new.
 */
function resumedDelta(
  now: ModelUsageTotals,
  baseline: ModelUsageTotals,
  floor: ModelUsageTotals,
  live: ModelUsageTotals,
): ModelUsageTotals {
  const field = (name: (typeof FIELDS)[number]): number =>
    now[name] >= baseline[name]
      ? Math.max(now[name] - baseline[name], live[name])
      : now[name] >= floor[name]
        ? live[name]
        : now[name];
  return {
    input: field("input"),
    output: field("output"),
    cacheCreate: field("cacheCreate"),
    cacheRead: field("cacheRead"),
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

/**
 * The CLI's `costUSD` at a turn end (DIPO-62): cumulative per process like `modelUsage`, so the
 * run adds only the change since the value last seen; a value below it means the CLI's count
 * restarted, so all of it is new. Models without `costUSD` keep what they had.
 */
function costStep(
  state: ClaudeParseState,
  modelUsage: Readonly<Record<string, z.infer<typeof ModelUsageEntry>>>,
): Pick<ClaudeParseState, "costCommitted" | "costBaseline"> {
  const committed: Record<string, number> = { ...state.costCommitted };
  const baseline: Record<string, number> = { ...state.costBaseline };
  const floor = state.costFloor;
  for (const [model, entry] of Object.entries(modelUsage)) {
    if (entry.costUSD === undefined) continue;
    const before = baseline[model] ?? 0;
    // A resumed session's first turn end. The cost baseline is the floor (costs come only from
    // results, so the previous session's spend after its last result was never priced): at or
    // above it the rise is new whichever way the CLI restored, so nothing is undercounted. A value
    // between floor and baseline (only possible with a baseline above the floor) adds nothing the
    // engine can price; below the floor the count restarted.
    const restored = floor === undefined ? null : (floor[model] ?? 0);
    const change =
      entry.costUSD >= before
        ? entry.costUSD - before
        : restored !== null && entry.costUSD >= restored
          ? 0
          : entry.costUSD;
    committed[model] = (committed[model] ?? 0) + change;
    baseline[model] = entry.costUSD;
  }
  return { costCommitted: committed, costBaseline: baseline };
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

// ---- the turn in progress (DIPO-296) ---------------------------------------------------------

/** The state without the live numbers of a turn in progress: at a turn end and at the exit. */
function withoutLive(state: ClaudeParseState): ClaudeParseState {
  const { liveTurns: _turns, liveOutput: _output, streaming: _streaming, ...rest } = state;
  return rest;
}

/** `next`, with a `liveUsage` event when its live numbers differ from `before`'s. */
function liveStep(before: ClaudeParseState, next: ClaudeParseState): Step {
  const turns = next.liveTurns ?? 0;
  const output = next.liveOutput ?? 0;
  if (turns === (before.liveTurns ?? 0) && output === (before.liveOutput ?? 0)) {
    return { events: [], state: next };
  }
  return { events: [{ t: "liveUsage", turns, output }], state: next };
}

/**
 * A main-agent `user` line after the turn's first message: tool results, or a message dipo sent
 * while the turn ran (a steer, an answer), is one more of the main agent's model turns, as the
 * result's `num_turns` counts it.
 */
function userLine(value: unknown, state: ClaudeParseState): Step {
  const parsed = UserLine.safeParse(value);
  if (!parsed.success || (parsed.data.parent_tool_use_id ?? null) !== null) {
    return { events: [], state };
  }
  // Only a turn the main agent started counts on.
  if ((state.liveTurns ?? 0) === 0) return { events: [], state };
  return liveStep(state, { ...state, liveTurns: (state.liveTurns ?? 0) + 1 });
}

/** A `stream_event` line: a main-agent message's start, and its final output count. */
function streamEvent(value: unknown, state: ClaudeParseState): Step {
  const start = StreamMessageStart.safeParse(value);
  if (start.success) {
    if ((start.data.parent_tool_use_id ?? null) !== null) return { events: [], state };
    return {
      events: [],
      state: { ...state, streaming: { id: start.data.event.message.id, counted: 0 } },
    };
  }
  const end = StreamMessageDelta.safeParse(value);
  const streaming = state.streaming;
  if (!end.success || streaming === undefined) return { events: [], state };
  if ((end.data.parent_tool_use_id ?? null) !== null) return { events: [], state };
  const output = end.data.event.usage.output_tokens;
  if (output <= streaming.counted) return { events: [], state };
  return liveStep(state, {
    ...state,
    liveOutput: (state.liveOutput ?? 0) + output - streaming.counted,
    streaming: { id: streaming.id, counted: output },
  });
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
  return { ...state, problems: [...(state.problems ?? []), text] };
}

/** The worker and its version, as a drift event or a notice names them (DIPO-315). */
function workerLabel(state: ClaudeParseState): string {
  return state.version === null
    ? "Claude Code (version not reported yet)"
    : `Claude Code ${state.version}`;
}

function driftEvent(state: ClaudeParseState, kind: StreamDriftKind, detail: string): WorkerEvent {
  return { t: "streamDrift", kind, detail, worker: workerLabel(state) };
}

/**
 * `step` with one `streamDrift` event of `kind` ahead of its events for each problem it added to
 * `before`'s (DIPO-315): the engine counts them and parks a run whose stream it cannot read.
 */
function withDrift(before: ClaudeParseState, step: Step, kind: StreamDriftKind): Step {
  const added = (step.state.problems ?? []).slice((before.problems ?? []).length);
  if (added.length === 0) return step;
  return {
    events: [...added.map((detail) => driftEvent(step.state, kind, detail)), ...step.events],
    state: step.state,
  };
}

/** Compactions this process already emitted; a state stored before DIPO-100 emitted every one. */
function reportedCompactions(state: ClaudeParseState): number {
  return state.compactReported ?? Math.max(state.compactBoundaries ?? 0, state.compactHooks ?? 0);
}

/**
 * Emits the compactions only the `PostCompact` hook reported, with no `preTokens` (DIPO-106):
 * their `compact_boundary` did not come by the turn end or the exit (DIPO-100).
 */
function flushCompactions(state: ClaudeParseState): Step {
  const reported = reportedCompactions(state);
  const hooks = state.compactHooks ?? 0;
  if (hooks <= reported) return { events: [], state };
  const events: WorkerEvent[] = [];
  for (let index = reported; index < hooks; index++) events.push({ t: "compacted" });
  return { events, state: { ...state, compactReported: hooks } };
}

/** Pure: one host line to Worker events (0008 section 3). */
export function interpret(line: HostLine, state: ClaudeParseState): Step {
  switch (line.ch) {
    case "stdout":
      return stdoutText(line.data, state);
    case "hook":
      return withDrift(state, hookLine(line.data, state, line.end ?? null), "schema");
    case "exit": {
      // Compaction counts are per process; a hook-only compaction is reported before they reset.
      const flushed = flushCompactions(state);
      const {
        compactBoundaries: _boundaries,
        compactHooks: _hooks,
        compactReported: _reported,
        // A thinking block the process never finished is not reported.
        thinkingTokens: _thinking,
        ...rest
      } = withoutLive(flushed.state);
      // A turn that never ended leaves no live numbers behind (DIPO-296).
      const live = (state.liveTurns ?? 0) > 0 || (state.liveOutput ?? 0) > 0;
      return {
        events: [
          ...flushed.events,
          ...(live ? [{ t: "liveUsage" as const, turns: 0, output: 0 }] : []),
        ],
        state: {
          ...rest,
          pending: "",
          truncated: state.truncated || state.pending !== "",
          started: false,
          model: null,
          exits: state.exits + 1,
        },
      };
    }
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
  if (!parsed.ok) {
    return withDrift(
      state,
      { events: [], state: problem(state, "unparseable stdout line") },
      "schema",
    );
  }
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

/**
 * One stream-json object. A line that fails its schema, and one of a type the adapter drops, is
 * also a `streamDrift` event (DIPO-315); a `result` that fails its schema is a `usage` drift,
 * since its usage cannot be read.
 */
export function message(value: unknown, state: ClaudeParseState): Step {
  const kind: StreamDriftKind = isRecord(value) && kindOf(value) === "result" ? "usage" : "schema";
  return withDrift(state, readMessage(value, state), kind);
}

function readMessage(value: unknown, state: ClaudeParseState): Step {
  if (!isRecord(value))
    return { events: [], state: problem(state, "stdout line is not an object") };
  if (!isKnown(value)) {
    const kind = kindOf(value);
    return {
      events: [
        driftEvent(state, "dropped", `message type ${kind} is not known, so it was dropped`),
      ],
      state: { ...state, unknownTypes: remember(state.unknownTypes, kind) },
    };
  }
  switch (kindOf(value)) {
    case "system/init":
      return init(value, state);
    case "assistant":
      return assistant(value, state);
    case "result": {
      // A compaction only the hook reported is due by the turn end (DIPO-100).
      const flushed = flushCompactions(state);
      return merge(flushed, result(value, flushed.state));
    }
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
      const boundaries = (state.compactBoundaries ?? 0) + 1;
      // The `PostCompact` hook may have counted this compaction first (DIPO-59); it waits for this
      // line's token count unless a turn end already reported it (DIPO-100).
      return boundaries > reportedCompactions(state)
        ? {
            events: [{ t: "compacted", preTokens: parsed.value.compact_metadata.pre_tokens }],
            state: { ...state, compactBoundaries: boundaries, compactReported: boundaries },
          }
        : {
            events: [],
            state: {
              ...state,
              compactBoundaries: boundaries,
              compactReported: reportedCompactions(state),
            },
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
    case "system/thinking_tokens":
      return thinkingTokens(value, state);
    case "user":
      return userLine(value, state);
    case "stream_event":
      return streamEvent(value, state);
    default:
      // Known, read for liveness only: status, task and hook progress.
      return { events: [], state };
  }
}

function modelMatches(planned: string, actual: string): boolean {
  if (planned === actual) return true;
  return MODEL_ALIASES.includes(planned) && actual.startsWith(`claude-${planned}-`);
}

/**
 * Records `model` as a classifier switch when it is neither the planned model nor already
 * recorded, with one `modelSwitched` event (DIPO-51). The recorded switches carry over to the
 * run's next session, so each switch is reported once per run. A switch already recorded under
 * its alias or its full id (the `PostModelSwitch` hook and the stream may name it differently,
 * DIPO-59) records the other name too, without a second event.
 */
function acceptSwitch(state: ClaudeParseState, model: string, from?: string): Step {
  const planned = state.plannedModel;
  if (planned === null || modelMatches(planned, model) || state.acceptedModels.includes(model)) {
    return { events: [], state };
  }
  const accepted = { ...state, acceptedModels: [...state.acceptedModels, model] };
  if (
    state.acceptedModels.some((known) => modelMatches(known, model) || modelMatches(model, known))
  ) {
    return { events: [], state: accepted };
  }
  return {
    events: [{ t: "modelSwitched", from: from ?? state.model ?? planned, to: model }],
    state: accepted,
  };
}

function init(value: unknown, state: ClaudeParseState): Step {
  const parsed = parseWith(InitMessage, value, state);
  if (!parsed.ok) return { events: [], state: parsed.state };
  const msg = parsed.value;
  const events: WorkerEvent[] = [];
  // `source` is the `<plugin>@<marketplace>` id; a plugin without one is named by its name, which
  // matches no id, so it refuses too (fail closed).
  const plugins = msg.plugins.map((plugin) => plugin.source ?? plugin.name);
  let next: ClaudeParseState = {
    ...state,
    sessionId: msg.session_id,
    version: msg.claude_code_version,
    plugins,
    skills: msg.skills,
  };

  // 0008 section 2: no API key, and the planned model or a recorded classifier switch.
  if (next.initRejected === null) {
    const placeholder = next.placeholderKey === true && next.reportKind !== "review";
    if (msg.apiKeySource !== "none" && !placeholder) {
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

  // 0008 amendment of 2026-10-12 (DIPO-108): a plugin the run settings did not switch off is a
  // start failure, not a rejected init, so the story stays Ready. Plugin hooks may already have
  // run (SessionStart runs before `system/init`); the run settings are the guard, this the backstop.
  // Checked only when the key source and the model passed: a session that fails those as well
  // stays a rejected init. `worker.plugins` does not apply to a reviewer (0019 section 4): it may
  // load no plugin but Claude Code's builtin ones.
  const allowed = next.allowedPlugins;
  if (
    allowed !== undefined &&
    allowed !== null &&
    next.initRejected === null &&
    next.startFailure === null
  ) {
    const review = next.reportKind === "review";
    const refused = refusedPlugins(plugins, review ? [] : allowed, next.knownPlugins ?? []);
    if (refused.length > 0) {
      const reason = pluginRefusal(refused, next.reportKind);
      next = { ...next, startFailure: reason };
      // A neutral event, so the engine stops the worker before its first tool call.
      events.push({ t: "startRefused", reason });
    }
  }

  // DIPO-130: the plan passed `--disable-slash-commands`, so a skill in `system/init` means the
  // flag did not hold, and a `/` message could expand it and register its hooks. Stopped here,
  // before any tool call, as a start failure; checked under the same conditions as the plugins,
  // and not when a plugin already refused (one `startRefused` per init).
  if (
    next.refuseSkills === true &&
    msg.skills.length > 0 &&
    next.initRejected === null &&
    next.startFailure === null
  ) {
    const reason = skillRefusal(msg.skills);
    next = { ...next, startFailure: reason };
    events.push({ t: "startRefused", reason });
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
    // A newer Claude Code than dipo was checked with (DIPO-315): the engine notes it once.
    const version = msg.claude_code_version;
    if (compareVersions(version, CHECKED_CLAUDE_VERSION) > 0) {
      events.push({
        t: "newerVersion",
        worker: "Claude Code",
        version,
        checked: CHECKED_CLAUDE_VERSION,
      });
    }
  } else if (next.model !== null && next.model !== msg.model) {
    // With a planned model the switch was reported when a message or a result first showed it.
    if (next.plannedModel === null) {
      events.push({ t: "modelSwitched", from: next.model, to: msg.model });
    }
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

/**
 * The input field of a tool call that says what it does beyond its path (DIPO-83): Bash's command,
 * the search pattern of Grep and Glob, WebFetch's URL and WebSearch's query. File contents and
 * edits are left out; their path already shows. The engine stores it only with the opt-in.
 */
const INPUT_FIELDS: Readonly<Record<string, string>> = {
  Bash: "command",
  Grep: "pattern",
  Glob: "pattern",
  WebFetch: "url",
  WebSearch: "query",
};

/**
 * What a Claude Code tool does, adapter-neutral (DIPO-186): the file tools that change a file are
 * `edit`, Bash is `shell`. The engine reads it to see whether verify ran after the last edit.
 */
const TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = {
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "shell",
};

/**
 * The output line of a web call: `[web] WebFetch https://…`, the input as one line but whole. The
 * engine redacts env values from the whole line before it cuts the input as other tool inputs
 * (`WebGuard.redactOutput`), so a value across the cut leaves no part of itself behind.
 */
export function webLine(tool: string, input: string | undefined): string {
  const line = input === undefined ? "" : flatInput(input);
  return `${WEB_LINE_PREFIX}${tool}${line === "" ? "" : ` ${line}`}\n`;
}

function toolInput(tool: string, input: unknown): string | undefined {
  const field = INPUT_FIELDS[tool];
  if (field === undefined || !isRecord(input)) return undefined;
  const value = input[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * A `system/thinking_tokens` line (DIPO-96): the estimate of the thinking block in progress. The
 * CLI sends the block's running total; a line with only the rise adds it to what came before.
 */
function thinkingTokens(value: unknown, state: ClaudeParseState): Step {
  const parsed = parseWith(ThinkingTokensMessage, value, state);
  if (!parsed.ok) return { events: [], state: parsed.state };
  const { estimated_tokens: total, estimated_tokens_delta: rise } = parsed.value;
  const tokens =
    total !== undefined
      ? total
      : rise !== undefined
        ? (state.thinkingTokens ?? 0) + rise
        : state.thinkingTokens;
  return {
    events: [],
    state: tokens === undefined ? state : { ...state, thinkingTokens: Math.round(tokens) },
  };
}

/**
 * The `thinking` activity of an assistant line that carries a finished thinking block (DIPO-96):
 * its duration and the token estimate gathered while it ran, never its text or signature. The CLI
 * puts each content block on its own line, so one line reports one block.
 */
function thinkingActivity(
  msg: z.infer<typeof AssistantMessage>,
  state: ClaudeParseState,
  scope: { readonly agentId?: string },
): Step {
  const thought = msg.message.content.some((block) => THINKING_BLOCK_TYPES.includes(block.type));
  const ms = msg.thinking_duration_ms;
  if (!thought && ms === undefined) return { events: [], state };
  const tokens = state.thinkingTokens;
  const { thinkingTokens: _done, ...rest } = state;
  return {
    events: [
      {
        t: "activity",
        kind: "thinking",
        ...(ms === undefined ? {} : { ms: Math.round(ms) }),
        ...(tokens === undefined ? {} : { tokens }),
        ...scope,
      },
    ],
    state: rest,
  };
}

function assistant(value: unknown, state: ClaudeParseState): Step {
  const parsed = parseWith(AssistantMessage, value, state);
  if (!parsed.ok) return { events: [], state: parsed.state };
  const msg = parsed.value;
  const agentId = msg.parent_tool_use_id ?? undefined;
  const scope = agentId === undefined ? {} : { agentId };
  // Thinking comes before the words and tool calls it led to.
  const thinking = thinkingActivity(msg, state, scope);
  const events: WorkerEvent[] = [...thinking.events];
  let next = thinking.state;

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
      const input = toolInput(tool.data.name, tool.data.input);
      // A web call always shows its query or URL (0020 section 11b), whatever the privacy opt-in
      // for tool inputs: its line is an output line of its own, and the activity carries no input.
      const web = WEB_TOOLS.includes(tool.data.name);
      const effect = TOOL_EFFECTS[tool.data.name];
      events.push({
        t: "activity",
        kind: "tool",
        tool: tool.data.name,
        ...(path === undefined ? {} : { path }),
        ...(input === undefined || web ? {} : { input }),
        ...(effect === undefined ? {} : { effect }),
        ...scope,
      });
      if (web && agentId === undefined) {
        events.push({ t: "output", text: webLine(tool.data.name, input) });
      }
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
    // The 1 hour part as `usage.cache_creation` reports it; the rest, or all of it when the
    // split is missing, is the default 5 minute cache. The parts always add up to the total.
    const oneHour = Math.min(
      counted.cacheCreate,
      usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    );
    events.push({
      t: "usage",
      messageId: msg.message.id,
      model: msg.message.model,
      ...scope,
      input: counted.input,
      output: usage.output_tokens,
      cacheCreate: counted.cacheCreate,
      cacheCreate5m: counted.cacheCreate - oneHour,
      cacheCreate1h: oneHour,
      cacheRead: counted.cacheRead,
    });
    next = {
      ...next,
      seen: [...next.seen, msg.message.id],
      live: addTotals(next.live, { [msg.message.model]: counted }),
      // The main agent's context size, for the resume check (0014 section 6).
      ...(agentId === undefined
        ? { contextTokens: counted.input + counted.cacheCreate + counted.cacheRead }
        : {}),
    };
  }
  // A main-agent message on a model the plan did not name is a classifier switch (0008 section
  // 2): recorded, so the next `system/init` on it is accepted.
  if (agentId === undefined) {
    const switched = acceptSwitch(next, msg.message.model);
    events.push(...switched.events);
    next = switched.state;
  }
  // The main agent's first message of a turn is its first model turn (DIPO-296).
  if (agentId === undefined && (next.liveTurns ?? 0) === 0) {
    const live = liveStep(next, { ...next, liveTurns: 1 });
    events.push(...live.events);
    next = live.state;
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

interface ReportRead {
  readonly report: WorkerReport | null;
  readonly review?: ReviewReport;
  readonly problem: string | null;
}

/** The report of the session's kind: a `WorkerReport`, or a `ReviewReport` for `review`. */
function readReport(output: unknown, kind: ReportKind | undefined): ReportRead {
  if (kind === "review") {
    const read = parseReviewReport(output);
    return read.ok
      ? { report: null, review: read.report, problem: null }
      : { report: null, problem: read.error };
  }
  // The door of W2 to W5 (DIPO-272): size cap, cleaned strings, strict schema.
  const read = parseWorkerReport(output);
  return read.ok ? { report: read.report, problem: null } : { report: null, problem: read.error };
}

function result(value: unknown, state: ClaudeParseState): Step {
  const parsed = parseWith(ResultMessage, value, state);
  if (!parsed.ok) return { events: [], state: parsed.state };
  const msg = parsed.value;
  const events: WorkerEvent[] = [];
  // The turn's numbers replace the live ones of the turn in progress (DIPO-296).
  let next: ClaudeParseState = { ...withoutLive(state), sessionId: msg.session_id };

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
  // The first turn end of a resumed session tells restored spend from a restarted count.
  const floor = next.restoredFloor;
  if (!none) {
    for (const [model, usage] of Object.entries(reported)) {
      const base = next.baseline[model] ?? ZERO_USAGE;
      change[model] =
        floor === undefined
          ? delta(usage, base)
          : resumedDelta(usage, base, floor[model] ?? ZERO_USAGE, next.live[model] ?? ZERO_USAGE);
    }
  }
  let drift = next.costDrift === true;
  if (none || !completed) {
    for (const model of new Set([...Object.keys(change), ...Object.keys(next.live)])) {
      const before = change[model] ?? ZERO_USAGE;
      change[model] = larger(before, next.live[model] ?? ZERO_USAGE);
      // Spend the CLI's totals leave out is now counted, so its cost no longer covers the run.
      if (FIELDS.some((field) => change[model]?.[field] !== before[field])) drift = true;
    }
  }
  const { restoredFloor: _floor, costFloor: _costFloor, ...rest } = next;
  const cost = costStep(next, msg.modelUsage);
  next = {
    ...(none ? next : rest),
    committed: addTotals(next.committed, change),
    live: {},
    baseline: none ? next.baseline : { ...next.baseline, ...reported },
    ...cost,
    costDrift: drift,
  };
  for (const model of Object.keys(reported)) {
    if (next.plannedModel === null) {
      if (!next.models.includes(model) && next.models.length > 0) {
        events.push({
          t: "modelSwitched",
          from: next.models[next.models.length - 1] ?? model,
          to: model,
        });
      }
    } else {
      const switched = acceptSwitch(next, model);
      events.push(...switched.events);
      next = switched.state;
    }
    next = { ...next, models: remember(next.models, model) };
  }
  // The main model's context window, for the resume check (0014 section 6).
  const main = next.model === null ? undefined : msg.modelUsage[next.model];
  const window =
    main?.contextWindow ??
    Object.values(msg.modelUsage).find((entry) => entry.contextWindow !== undefined)?.contextWindow;
  if (window !== undefined) next = { ...next, contextWindow: window };

  // A completed turn always spent tokens: one that reports none means the CLI's usage moved where
  // dipo does not read it, so the caps would not see the turn (DIPO-315). An aborted or failed
  // turn may report none (the `pause-now` and `start-failed` recordings), so only a completed
  // one drifts. The drift comes ahead of the turn, so the run parks before its report decides.
  if (none && completed) {
    events.unshift(
      driftEvent(
        next,
        "usage",
        `a completed turn's result reports no token usage (${msg.terminal_reason ?? msg.subtype})`,
      ),
    );
  }
  const read = readReport(msg.structured_output, next.reportKind);
  // A session that failed its start (an unlisted plugin, DIPO-108, or a skill, DIPO-130) reports
  // nothing the engine may act on: its turn carries no report, so verify and commit never run on
  // it, and the start failure decides.
  const report = next.startFailure === null ? read.report : null;
  const review = next.startFailure === null ? read.review : undefined;
  const reportProblem = next.startFailure === null ? read.problem : next.startFailure;
  const terminal = msg.terminal_reason ?? msg.subtype;
  const turn: TurnRecord = {
    subtype: msg.subtype,
    terminal,
    report,
    ...(review === undefined ? {} : { review }),
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
  if (turn.apiErrorStatus === 429) {
    // 0008 section 7: a turn ended by a 429 is a rejected plan limit, as a `rate_limit_event`
    // with `status: rejected` would be.
    events.push({ t: "limit", status: "rejected" });
    if (next.planLimit === null)
      next = { ...next, planLimit: "turn ended by a 429 rate-limit error" };
  }

  const costUsd = next.costCommitted ?? {};
  const comparable = !drift && Object.keys(costUsd).length > 0;
  const trouble = turnProblem(msg.subtype, turn, next);
  events.push({
    t: "turn",
    report,
    ...(review === undefined ? {} : { review }),
    totals: next.committed,
    ...(comparable ? { costUsd } : {}),
    numTurns: msg.num_turns,
    terminal,
    ...(msg.subtype === "error_max_turns"
      ? { capped: `turn cap (--max-turns) after ${msg.num_turns} turns` }
      : {}),
    ...(trouble === null ? {} : { problem: trouble }),
  });
  if (
    report?.status === "blocked" &&
    report.question !== undefined &&
    report.needsPermission === undefined
  ) {
    events.push({ t: "waiting", on: "question", detail: report.question });
  }
  return { events, state: next };
}

/**
 * What was wrong with a turn, in the order 0008 section 7 reads it (DIPO-51): a plan limit, a
 * start failure, a full context, an execution error, then a missing or invalid report. A turn at
 * the CLI's turn cap carries `capped` instead.
 */
function turnProblem(
  subtype: string,
  turn: TurnRecord,
  state: ClaudeParseState,
): TurnProblem | null {
  if (turn.apiErrorStatus === 429) {
    return { kind: "planLimit", detail: "turn ended by a 429 rate-limit error" };
  }
  if (state.startFailure !== null) return { kind: "startFailed", detail: state.startFailure };
  if (subtype === "error_max_turns") return null;
  if (turn.terminal === "prompt_too_long") {
    return { kind: "contextFull", detail: "prompt_too_long: the context is full" };
  }
  if (subtype === "error_max_structured_output_retries") {
    return { kind: "report", detail: "error_max_structured_output_retries" };
  }
  if (subtype !== "success") {
    const why =
      turn.apiErrorStatus === null
        ? turn.terminal
        : `${turn.terminal}, HTTP ${turn.apiErrorStatus}`;
    const last = state.lastError === null ? "" : `, last error ${state.lastError}`;
    return { kind: "error", detail: `${subtype} (${why})${last}` };
  }
  if (turn.report === null && turn.review === undefined) {
    return { kind: "report", detail: turn.reportProblem ?? "no report" };
  }
  return null;
}

function epochIso(seconds: number | undefined): string | undefined {
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

/**
 * The plan-limit scope of a `rateLimitType` (DIPO-61): the live recordings show `five_hour`, the
 * session window; `seven_day` is the weekly window and `seven_day_<family>` that model family's
 * weekly limit. Anything else is left out, so the engine treats it as `unknown`.
 */
export function rateLimitScope(type: string | undefined): PlanLimitScope | undefined {
  if (type === "five_hour") return "session";
  if (type === "seven_day") return "weekly";
  const family = /^seven_day_([a-z]+)$/.exec(type ?? "")?.[1];
  return family === undefined ? undefined : `model:${family}`;
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
  const scope = rateLimitScope(info.rateLimitType);
  const events: WorkerEvent[] = [
    {
      t: "limit",
      status: info.status,
      ...(utilization === undefined ? {} : { utilization: Math.min(1, utilization) }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(credits ? { creditsRequired: true } : {}),
      ...(scope === undefined ? {} : { scope }),
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

/**
 * One relayed hook payload (0008 sections 3 and 5, DIPO-59): the neutral `hook` event the engine
 * acts on, plus the worker events the payload also stands for. `call` is the hook line's end
 * offset, the id of a waiting `PermissionRequest` call.
 */
function hookLine(data: string, state: ClaudeParseState, call: number | null): Step {
  const parsedJson = tryParse(data);
  if (!parsedJson.ok) return { events: [], state: problem(state, "unparseable hook line") };
  const parsed = parseWith(HookPayload, parsedJson.value, state);
  if (!parsed.ok) return { events: [], state: parsed.state };
  const hook = parsed.value;
  const neutral = hookEventOf(hook, call);
  const events: WorkerEvent[] = neutral === null ? [] : [{ t: "hook", hook: neutral }];
  let next = state;
  switch (neutral?.kind) {
    case "permissionRequest":
      // The primary permission-wait signal (0008 sections 3 and 5).
      events.push({ t: "waiting", on: "permission", detail: neutral.tool });
      break;
    case "stopFailed":
      if (hook.error === "rate_limit") {
        events.push(
          { t: "limit", status: "rate_limit" },
          { t: "waiting", on: "plan-limit", detail: "StopFailure rate_limit" },
        );
        next = { ...next, planLimit: next.planLimit ?? "StopFailure rate_limit" };
      }
      break;
    case "compacted":
      // The same compaction as a `compact_boundary` line, in either order (DIPO-42 review). The
      // hook has no token count, so a hook ahead of the boundaries emits nothing yet: the boundary
      // that follows reports it with its `pre_tokens`, else the turn end or exit does (DIPO-100).
      next = {
        ...next,
        compactHooks: (next.compactHooks ?? 0) + 1,
        compactReported: reportedCompactions(next),
      };
      break;
    case "modelSwitched": {
      const switched = hookModelSwitch(next, neutral.to, neutral.from);
      events.push(...switched.events);
      next = switched.state;
      break;
    }
    default:
      break;
  }
  return { events, state: next };
}

/**
 * A `PostModelSwitch` hook, deduplicated against the `system/init` and `modelUsage` paths
 * (DIPO-42 review): with a planned model, as a recorded classifier switch; without one, only when
 * the stream has not shown the model yet.
 */
function hookModelSwitch(state: ClaudeParseState, to: string, from: string | undefined): Step {
  if (state.plannedModel !== null) return acceptSwitch(state, to, from);
  if (state.model === to || state.models.includes(to)) return { events: [], state };
  return {
    events: [{ t: "modelSwitched", from: from ?? state.model ?? to, to }],
    state: {
      ...state,
      ...(state.started ? { model: to } : {}),
      models: remember(state.models, to),
    },
  };
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
