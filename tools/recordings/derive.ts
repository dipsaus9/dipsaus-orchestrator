// `bun run recordings:derive` (0017 section 2, "Scenarios"): the derived recordings are small,
// pure transforms of the committed live recordings, so they regenerate on every refresh and a
// unit test can check that the committed copies are current. Field values the docs name but no
// live run showed (for example `startup_failure_reason`) are marked in `meta.cites`.

import { refusalText } from "../../packages/engine/src/index";
import { WEB_ENV_FILE, WEB_ENV_KEY, WEB_QUERY, WEB_REFUSED_URL, WEB_URL } from "./scenarios";

import type { Envelope, Meta, Recording } from "./format";
import { isRecord, readRecording, serializeMeta, serializeStream, writeRecording } from "./format";
import { redact } from "./scrub";
import { guardSecrets, machineNeedles } from "./secrets";
import { budgetTokens, stdoutOf, usageChecksum } from "./usage";

type Data = Record<string, unknown>;

export interface Derived {
  readonly name: string;
  readonly lines: readonly Envelope[];
  readonly meta: Meta;
}

interface Transform {
  readonly name: string;
  readonly from: string;
  readonly transform: string;
  readonly expected: string;
  readonly cites?: readonly string[];
  /** The worker kind the derived session ran as, when not `implement`. */
  readonly kind?: "review";
  readonly apply: (lines: readonly Envelope[]) => Envelope[];
  readonly testConfig?: (lines: readonly Envelope[]) => Record<string, unknown>;
}

const STALL_MS = 30 * 60 * 1000;
const CITE_RESULT =
  "Claude Code docs, Agent SDK TypeScript reference: SDKResultMessage (0008 source 4)";
const CITE_ASSISTANT_ERROR =
  "Claude Code docs, Agent SDK TypeScript reference: SDKAssistantMessage error (0008 source 4)";

const CITE_TERMINAL =
  'terminal_reason "error" and stop_reason null on derived failure results are illustrative; live failures showed "aborted_streaming" and "max_turns"';

/** A failed result: no report, no stop reason, one terminal reason across every derived failure. */
function failure(result: Data, subtype: string, terminalReason = "error"): Data {
  return {
    ...withoutReport(result),
    subtype,
    is_error: true,
    stop_reason: null,
    terminal_reason: terminalReason,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isType(line: Envelope, type: string): boolean {
  return line.ch === "stdout" && isRecord(line.data) && line.data.type === type;
}

function isInit(line: Envelope): boolean {
  return isType(line, "system") && (line.data as Data).subtype === "init";
}

function indexOf(lines: readonly Envelope[], test: (line: Envelope) => boolean, from = 0): number {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && test(line)) return i;
  }
  throw new Error("derive: the source recording lacks a line the transform needs");
}

function lastIndexOf(lines: readonly Envelope[], test: (line: Envelope) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && test(line)) return i;
  }
  throw new Error("derive: the source recording lacks a line the transform needs");
}

function at(lines: readonly Envelope[], index: number): Envelope {
  const line = lines[index];
  if (line === undefined) throw new Error(`derive: no line ${index}`);
  return line;
}

function exit(t: number, code: number | null, signal: string | null = null): Envelope {
  return { t, ch: "exit", data: { code, signal } };
}

/** Every number under `value` set to zero, keeping its keys. */
function zeroed(value: unknown): unknown {
  if (typeof value === "number") return 0;
  if (Array.isArray(value)) return value.map(zeroed);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, zeroed(v)]));
  return value;
}

/** The first result of the recording, rewritten by `edit`; everything after it replaced by an exit. */
function replaceFirstResult(
  lines: readonly Envelope[],
  edit: (result: Data) => Data,
  code: number,
): Envelope[] {
  const index = indexOf(lines, (line) => isType(line, "result"));
  const result = at(lines, index);
  const data = edit(clone(result.data as Data));
  return [
    ...lines.slice(0, index).map(clone),
    { t: result.t, ch: "stdout", data },
    exit(result.t + 40, code),
  ];
}

function withoutReport(result: Data): Data {
  const { structured_output: _report, ...rest } = result;
  return rest;
}

/** Init and what came before it, then `tail`. */
function afterInit(lines: readonly Envelope[], tail: (init: Envelope) => Envelope[]): Envelope[] {
  const index = indexOf(lines, isInit);
  return [...lines.slice(0, index + 1).map(clone), ...tail(at(lines, index))];
}

function failedResult(lines: readonly Envelope[], extra: Data): Data {
  const result = clone(
    at(
      lines,
      indexOf(lines, (line) => isType(line, "result")),
    ).data as Data,
  );
  return {
    ...failure(result, "error_during_execution"),
    ...(zeroed({
      num_turns: 0,
      duration_ms: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
      usage: result.usage,
    }) as Data),
    modelUsage: {},
    permission_denials: [],
    ...extra,
  };
}

function assistantError(lines: readonly Envelope[], error: string): Envelope[] {
  return afterInit(lines, (init) => {
    const assistant = clone(
      at(
        lines,
        indexOf(lines, (line) => isType(line, "assistant")),
      ).data as Data,
    );
    const message = isRecord(assistant.message) ? assistant.message : {};
    const errored: Data = {
      ...assistant,
      error,
      message: {
        ...message,
        content: [{ type: "text", text: redact("") }],
      },
    };
    return [
      { t: init.t + 300, ch: "stdout", data: errored },
      { t: init.t + 310, ch: "stdout", data: failedResult(lines, {}) },
      exit(init.t + 350, 1),
    ];
  });
}

// The review kind (0019 sections 4 and 5, DIPO-145). The worker sandbox that built these has no
// network, so no live review run exists yet; the maintainer captures the `review-*-live`
// scenarios. Until then the review recordings are the live `success-single` session with the
// reviewer's system/init (its four tools, no skill, no slash command) and a review report.

/** The tools a reviewer's system/init lists: the four of 0019 section 4 and the report tool. */
const REVIEW_INIT_TOOLS = ["Bash", "Glob", "Grep", "Read", "StructuredOutput"];

const CITE_REVIEW_INIT =
  "system/init tools Bash, Glob, Grep, Read and StructuredOutput are those --tools Read,Glob,Grep,Bash asks for; no live review run showed them (0019 section 4)";
const CITE_REVIEW_SKILLS =
  "system/init skills [] and slash_commands [] as the live safety-slash-skill recording showed under --disable-slash-commands";
const CITE_REVIEW_REPORT =
  "structured_output, the StructuredOutput tool_use input and its input_json_delta stream events carry one illustrative ReviewReport (0019 section 5); no live review run returned one";
// The replay tests check the findings' file, line and quote, and a review judge checks a quote
// against the code tree (0019 section 5), so the injected text stays readable.
const CITE_REVIEW_PLAIN =
  "the review report's text fields (evidence, text, file, quote, summary) are left unredacted on purpose, where a live capture redacts them (tools/recordings/scrub.ts): they are fixed illustrative text, not a live session's, and the replay tests read them";

const REVIEW_APPROVED: Data = {
  criteria: [{ n: 1, status: "met", evidence: "src/greet.ts returns hello, <name>." }],
  findings: [],
  summary: "The change meets its one criterion; nothing to report.",
};

const REVIEW_BLOCKED: Data = {
  criteria: [{ n: 1, status: "unmet", evidence: "greet returns Hi, not hello." }],
  findings: [
    {
      severity: "blocking",
      kind: "correctness",
      criterion: 1,
      file: "src/greet.ts",
      line: 3,
      quote: "return `Hi, ${name}`;",
      text: "The greeting word is hello, as notes.txt fixes it.",
    },
    {
      severity: "blocking",
      kind: "test",
      testEntry: 1,
      text: "No test of greet for a name, which automated entry 1 asks for.",
    },
    {
      severity: "advisory",
      kind: "maintainability",
      file: "src/greet.ts",
      text: "The greeting word could be one exported constant.",
    },
  ],
  summary: "Criterion 1 is unmet and automated test entry 1 has no test.",
};

/** The tool Claude Code returns the `--json-schema` report through. */
const REPORT_TOOL = "StructuredOutput";

function isReportToolUse(block: unknown): boolean {
  return isRecord(block) && block.type === "tool_use" && block.name === REPORT_TOOL;
}

/** True for an assistant line whose content holds the report tool use. */
function hasReportToolUse(line: Envelope): boolean {
  if (!isType(line, "assistant")) return false;
  const message = (line.data as Data).message;
  return (
    isRecord(message) && Array.isArray(message.content) && message.content.some(isReportToolUse)
  );
}

/** The stream event's `event`, when the line is one. */
function streamEvent(line: Envelope): Data | null {
  if (!isType(line, "stream_event")) return null;
  const event = (line.data as Data).event;
  return isRecord(event) ? event : null;
}

/**
 * The indexes of the `input_json_delta` stream events before `end` that build a report tool use,
 * in order: those between the report block's `content_block_start` and its `content_block_stop`.
 */
function reportDeltas(lines: readonly Envelope[], end: number): number[] {
  const open = new Set<string>();
  const deltas: number[] = [];
  for (let i = 0; i < end; i++) {
    const line = at(lines, i);
    const event = streamEvent(line);
    if (event === null) continue;
    const block = `${String((line.data as Data).api_message_id)}:${String(event.index)}`;
    if (event.type === "content_block_start" && isReportToolUse(event.content_block)) {
      open.add(block);
    } else if (event.type === "content_block_stop") {
      open.delete(block);
    } else if (
      event.type === "content_block_delta" &&
      open.has(block) &&
      isRecord(event.delta) &&
      event.delta.type === "input_json_delta"
    ) {
      deltas.push(i);
    }
  }
  return deltas;
}

/** `text` cut into `count` consecutive pieces of near equal length; joined they are `text`. */
function pieces(text: string, count: number): string[] {
  const size = Math.ceil(text.length / Math.max(count, 1));
  return Array.from({ length: count }, (_, i) => text.slice(i * size, (i + 1) * size));
}

/**
 * The source session as a reviewer's: its init, and its first turn carrying `report` wherever the
 * source's report was: the report tool use's input, the `input_json_delta` events that stream it,
 * and the result's `structured_output`.
 */
function asReview(lines: readonly Envelope[], report: unknown): Envelope[] {
  const result = indexOf(lines, (line) => isType(line, "result"));
  const toolUse = indexOf(lines, hasReportToolUse);
  if (toolUse > result) throw new Error("derive: the report tool use comes after the result");
  const deltas = reportDeltas(lines, result);
  const partial = pieces(JSON.stringify(report), deltas.length);
  return lines.map((line, index) => {
    const delta = deltas.indexOf(index);
    if (delta !== -1) {
      const data = clone(line.data as Data);
      const event = data.event as Data;
      return {
        ...line,
        data: {
          ...data,
          event: { ...event, delta: { ...(event.delta as Data), partial_json: partial[delta] } },
        },
      };
    }
    if (index === toolUse) {
      const data = clone(line.data as Data);
      const message = data.message as Data;
      const content = (message.content as unknown[]).map((block) =>
        isReportToolUse(block) ? { ...(block as Data), input: clone(report) } : block,
      );
      return { ...line, data: { ...data, message: { ...message, content } } };
    }
    if (isInit(line)) {
      return {
        ...line,
        data: {
          ...clone(line.data as Data),
          tools: REVIEW_INIT_TOOLS,
          skills: [],
          slash_commands: [],
        },
      };
    }
    if (index === result) {
      return { ...line, data: { ...clone(line.data as Data), structured_output: clone(report) } };
    }
    return clone(line);
  });
}

/** The source's own worker report: valid for `implement`, invalid for the review schema. */
function workerReport(lines: readonly Envelope[]): unknown {
  const result = at(
    lines,
    indexOf(lines, (line) => isType(line, "result")),
  ).data as Data;
  return result.structured_output;
}

// The web tools (0020 section 11b, DIPO-164). The worker sandbox that built this has no network, so
// no live run with a WebSearch, a WebFetch or the PreToolUse hook exists yet; the maintainer
// captures the `web` scenario. Until then the web recording is the live `success-tools-subagent`
// session cut to its first turn: its init, three tool calls built on its Read call, and its
// report turn.

/** The tools a developer's system/init lists with `worker.web`. */
const WEB_INIT_TOOLS = [
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "Read",
  "StructuredOutput",
  "WebFetch",
  "WebSearch",
  "Write",
];

const CITE_WEB_INIT =
  "system/init tools lists WebFetch and WebSearch besides the six of the developer role; no live run with worker.web showed them (0020 section 11b)";
const CITE_WEB_CALLS =
  "the WebSearch, WebFetch and refused WebFetch assistant tool_use blocks, their tool results and their message ids are built on the live Read call of the source; no live run called a web tool";
const CITE_WEB_HOOK =
  "the PreToolUse hook payloads follow the Claude Code hooks reference (tool_name, tool_input.url or tool_input.query); no live run registered the hook";
const CITE_WEB_DENY =
  "the refused call's tool_result (is_error, the engine's reason as its text) is illustrative; no live run showed how Claude Code reports a PreToolUse deny, and its text fields are left unredacted on purpose, where a live capture redacts them";
const CITE_WEB_PLAIN =
  "the tool_use input (query, url) of the three calls and the hook payloads' tool_input are fixed illustrative text, left unredacted on purpose, where a live capture keeps them only through the web scrub rules (tools/recordings/scrub.ts)";

/** One web call: the assistant tool_use, the PreToolUse hook payload and the tool result. */
function webCall(
  read: { readonly assistant: Envelope; readonly user: Envelope },
  call: {
    readonly n: number;
    readonly t: number;
    readonly tool: "WebSearch" | "WebFetch";
    readonly input: Data;
    readonly result: string;
    readonly refused?: boolean;
  },
): Envelope[] {
  const id = `toolu-w${call.n}`;
  const assistant = clone(read.assistant.data as Data);
  const message = clone(assistant.message as Data);
  assistant.message = {
    ...message,
    id: `msg-w${call.n}`,
    content: [
      { type: "tool_use", id, name: call.tool, input: call.input, caller: { type: "direct" } },
    ],
  };
  assistant.wire_tool_inputs = { [id]: call.input };
  assistant.uuid = `uuid-w${call.n}a`;
  assistant.request_id = `req-w${call.n}`;
  const user = clone(read.user.data as Data);
  user.message = {
    role: "user",
    content: [
      {
        tool_use_id: id,
        type: "tool_result",
        content: call.result,
        ...(call.refused === true ? { is_error: true } : {}),
      },
    ],
  };
  user.uuid = `uuid-w${call.n}b`;
  delete user.tool_use_result;
  delete user.tool_result_meta;
  return [
    { t: call.t, ch: "stdout", data: assistant },
    {
      t: call.t + 4,
      ch: "hook",
      data: {
        session_id: "session-1",
        transcript_path: "${TRANSCRIPT}",
        cwd: "${WORKDIR}",
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: call.tool,
        tool_input: call.input,
        tool_use_id: id,
      },
    },
    { t: call.t + 600, ch: "stdout", data: user },
  ];
}

/**
 * The source's first turn as a developer's with web tools: its init header, a WebSearch, a WebFetch
 * and a WebFetch the PreToolUse hook refused, then its report turn from the first thinking
 * block; the second turn is dropped.
 */
function withWebCalls(lines: readonly Envelope[]): Envelope[] {
  const firstResult = indexOf(lines, (line) => isType(line, "result"));
  const readCall = indexOf(lines, (line) => isType(line, "assistant"));
  const read = {
    assistant: at(lines, readCall),
    user: at(
      lines,
      indexOf(lines, (line) => isType(line, "user"), readCall),
    ),
  };
  const header = lines.slice(0, indexOf(lines, isInit) + 2).map(clone);
  // The report turn starts after the source's last background task change (its subagent ended).
  const first =
    lastIndexOf(
      lines.slice(0, firstResult),
      (line) =>
        isType(line, "system") && (line.data as Data).subtype === "background_tasks_changed",
    ) + 1;
  const t0 = at(lines, first).t;
  const calls = [
    webCall(read, {
      n: 1,
      t: t0,
      tool: "WebSearch",
      input: { query: WEB_QUERY },
      result: `Web search results for "${WEB_QUERY}": 1 result.`,
    }),
    webCall(read, {
      n: 2,
      t: t0 + 1_000,
      tool: "WebFetch",
      input: { url: WEB_URL, prompt: "Summarise how to run a single test file." },
      result: "bun test runs files matching *.test.ts; pass a path to run one file.",
    }),
    webCall(read, {
      n: 3,
      t: t0 + 2_000,
      tool: "WebFetch",
      input: { url: WEB_REFUSED_URL, prompt: "Read the page." },
      result: refusalText("WebFetch", { file: WEB_ENV_FILE, key: WEB_ENV_KEY }),
      refused: true,
    }),
  ].flat();
  const shift = 2_000 + 1_200 - (at(lines, first).t - t0);
  const tail = lines
    .slice(first, firstResult + 1)
    .map((line) => ({ ...clone(line), t: line.t + shift }));
  const last = tail.at(-1)?.t ?? t0;
  return [
    ...header.map((line) => (isInit(line) ? withInitTools(line) : line)),
    ...calls,
    ...tail,
    exit(last + 60, 0),
  ];
}

function withInitTools(line: Envelope): Envelope {
  return { ...line, data: { ...clone(line.data as Data), tools: WEB_INIT_TOOLS } };
}

export const TRANSFORMS: readonly Transform[] = [
  {
    name: "terminated",
    from: "success-tools-subagent",
    transform:
      "Cut after the last assistant message before the first result; exit 143 with no result (SIGTERM).",
    expected:
      "With no intent recorded the outcome is crashed; usage recovered from assistant messages; one resume if budget remains, else park worker-failed (0008 section 7).",
    apply: (lines) => {
      const result = indexOf(lines, (line) => isType(line, "result"));
      const cut = lastIndexOf(lines.slice(0, result), (line) => isType(line, "assistant"));
      const kept = lines.slice(0, cut + 1).map(clone);
      return [...kept, exit(at(lines, cut).t + 50, 143)];
    },
  },
  {
    name: "crash-truncated",
    from: "success-single",
    transform: "The result line cut mid-line (a partial stdout line), then exit 1.",
    expected:
      "The parser survives a partial line; the failure is recorded and the story is not lost.",
    apply: (lines) => {
      const index = indexOf(lines, (line) => isType(line, "result"));
      const result = at(lines, index);
      const text = JSON.stringify(result.data);
      return [
        ...lines.slice(0, index).map(clone),
        { t: result.t, ch: "stdout", data: text.slice(0, Math.floor(text.length / 2)) },
        exit(result.t + 40, 1),
      ];
    },
  },
  {
    name: "crash-zeroed",
    from: "success-tools-subagent",
    transform:
      "The result becomes error_during_execution with zeroed totals and no report; exit 1.",
    expected:
      "Usage recovered from earlier assistant messages, not overwritten with zero (0017 source 5).",
    cites: [CITE_RESULT, CITE_TERMINAL],
    apply: (lines) =>
      replaceFirstResult(
        lines,
        (result) => ({
          ...failure(result, "error_during_execution"),
          total_cost_usd: 0,
          usage: zeroed(result.usage),
          modelUsage: {},
        }),
        1,
      ),
  },
  {
    name: "init-rejected",
    from: "success-single",
    transform: 'system/init apiKeySource set to "ANTHROPIC_API_KEY".',
    expected:
      "Outcome initRejected: worker stopped, park worker-failed, engine.notice (0008 sections 2 and 7).",
    apply: (lines) =>
      lines.map((line) =>
        isInit(line)
          ? { ...line, data: { ...clone(line.data as Data), apiKeySource: "ANTHROPIC_API_KEY" } }
          : clone(line),
      ),
  },
  {
    name: "init-rejected-model",
    from: "success-single",
    transform: 'system/init model set to "claude-sonnet-4-5", a model the plan did not ask for.',
    expected:
      "Outcome initRejected unless a classifier switch is recorded on the run: worker stopped, park worker-failed, engine.notice (0008 sections 2 and 7).",
    apply: (lines) =>
      lines.map((line) =>
        isInit(line)
          ? { ...line, data: { ...clone(line.data as Data), model: "claude-sonnet-4-5" } }
          : clone(line),
      ),
  },
  {
    name: "start-failed",
    from: "success-single",
    transform:
      'After system/init, a result error_during_execution with startup_failure_reason "sandbox_unavailable" and zeroed totals; exit 1.',
    expected:
      "Outcome startFailed: scheduling for this adapter stopped in all offices, engine.notice, the story stays Ready (0008 section 7).",
    cites: [
      CITE_RESULT,
      CITE_TERMINAL,
      "startup_failure_reason value is illustrative; no live run showed one",
    ],
    apply: (lines) =>
      afterInit(lines, (init) => [
        {
          t: init.t + 20,
          ch: "stdout",
          data: failedResult(lines, { startup_failure_reason: "sandbox_unavailable" }),
        },
        exit(init.t + 60, 1),
      ]),
  },
  {
    name: "start-failed-auth",
    from: "success-single",
    transform:
      'An assistant message with error "authentication_failed", then a failed result; exit 1.',
    expected: "Outcome startFailed (0008 section 7).",
    cites: [CITE_ASSISTANT_ERROR, CITE_TERMINAL],
    apply: (lines) => assistantError(lines, "authentication_failed"),
  },
  {
    name: "start-failed-billing",
    from: "success-single",
    transform: 'An assistant message with error "billing_error", then a failed result; exit 1.',
    expected: "Outcome startFailed (0008 section 7).",
    cites: [CITE_ASSISTANT_ERROR, CITE_TERMINAL],
    apply: (lines) => assistantError(lines, "billing_error"),
  },
  {
    name: "report-invalid",
    from: "success-single",
    transform: "The result becomes error_max_structured_output_retries without a report.",
    expected:
      'No outcome yet: one feedback turn "report in the schema", then park ambiguous-spec (0008 section 7, 0014 section 2).',
    cites: [CITE_RESULT, CITE_TERMINAL],
    apply: (lines) =>
      replaceFirstResult(
        lines,
        (result) => failure(result, "error_max_structured_output_retries"),
        1,
      ),
  },
  {
    name: "report-invalid-missing",
    from: "success-single",
    transform: "The successful result loses its structured_output.",
    expected:
      "A turn that ends without a valid report: the same feedback turn, then park ambiguous-spec.",
    apply: (lines) => replaceFirstResult(lines, withoutReport, 0),
  },
  {
    name: "prompt-too-long",
    from: "success-single",
    transform:
      'The result becomes error_during_execution with terminal_reason "prompt_too_long" and no report.',
    expected:
      "No outcome yet: one new session with a 0014 handoff; a second hit parks budget-exceeded (0008 section 7).",
    cites: [CITE_RESULT, CITE_TERMINAL],
    apply: (lines) =>
      replaceFirstResult(
        lines,
        (result) => failure(result, "error_during_execution", "prompt_too_long"),
        1,
      ),
  },
  {
    name: "plan-limit-rejected",
    from: "success-single",
    transform:
      'The first rate_limit_event becomes status "rejected" (five_hour, its resetsAt kept); the stream ends after it with exit 0, as when the engine closes stdin.',
    expected:
      "Outcome plan-limit: stdin closed, a wait fact { scope, resetsAt?, since } on the run, work.observed plan-limit (health limited); never a park (0008 section 7).",
    cites: [
      'rate_limit_event status "rejected" is illustrative; live runs showed only "allowed" (0008 source 10)',
    ],
    apply: (lines) => {
      const index = indexOf(lines, (line) => isType(line, "rate_limit_event"));
      const event = at(lines, index);
      const data = clone(event.data as Data);
      const info = isRecord(data.rate_limit_info) ? data.rate_limit_info : {};
      return [
        ...lines.slice(0, index).map(clone),
        {
          t: event.t,
          ch: "stdout",
          data: { ...data, rate_limit_info: { ...info, status: "rejected" } },
        },
        exit(event.t + 40, 0),
      ];
    },
  },
  {
    name: "plan-limit-429",
    from: "success-single",
    transform:
      "The first result becomes error_during_execution with api_error_status 429 and no report; exit 1.",
    expected:
      "Outcome plan-limit: a turn ended by a 429 rate-limit error is a rejected plan limit; never a park (0008 section 7).",
    cites: [CITE_RESULT, CITE_TERMINAL],
    apply: (lines) =>
      replaceFirstResult(
        lines,
        (result) => ({ ...failure(result, "error_during_execution"), api_error_status: 429 }),
        1,
      ),
  },
  {
    name: "model-switch",
    from: "success-single",
    transform:
      'The first main-agent assistant message reports model "claude-sonnet-4-5", a classifier switch the plan did not ask for.',
    expected:
      "A classifier switch: recorded on the run with an engine.notice, the next system/init on that model is accepted, no park (0008 section 2).",
    cites: ["the switched model is illustrative; no live run switched models"],
    apply: (lines) => {
      const index = indexOf(lines, (line) => isType(line, "assistant"));
      return lines.map((line, i) => {
        if (i !== index) return clone(line);
        const data = clone(line.data as Data);
        const message = isRecord(data.message) ? data.message : {};
        return { ...line, data: { ...data, message: { ...message, model: "claude-sonnet-4-5" } } };
      });
    },
  },
  {
    name: "stall",
    from: "success-tools-subagent",
    transform: "A 30-minute gap in t after the first assistant message.",
    expected:
      "Stall detection fires on the injected clock (timeouts.workerStallMinutes, default 20).",
    apply: (lines) => {
      const first = indexOf(lines, (line) => isType(line, "assistant"));
      return lines.map((line, index) =>
        index > first ? { ...clone(line), t: line.t + STALL_MS } : clone(line),
      );
    },
  },
  {
    name: "budget-engine-cap",
    from: "success-tools-subagent",
    transform:
      "The stream unchanged; meta.testConfig sets the tier budget to half the recorded budget tokens.",
    expected:
      "The engine sees budget tokens (input + output + cache creation) pass the tier's budgetTokens, stops the worker and parks budget-exceeded; never raises the budget.",
    apply: (lines) => lines.map(clone),
    testConfig: (lines) => ({ budgetTokens: Math.floor(budgetTokens(lines) / 2) }),
  },
  {
    name: "web-calls",
    from: "success-tools-subagent",
    transform:
      "The first turn only; system/init lists WebFetch and WebSearch; a WebSearch, a WebFetch and a WebFetch whose URL holds a fixture env value, each with its PreToolUse hook line and tool result (the third refused, its result naming the env file and key and not the value); then the source's report turn.",
    expected:
      "Each web call shows in the worker output with its query or URL, and the calls are counted by tool: 1 WebSearch and 2 WebFetch. The PreToolUse hook lines relay the whole query or URL; the engine denies the third, whose URL holds a value from the fixture env file, naming the file and key and never the value (0020 section 11b).",
    cites: [CITE_WEB_INIT, CITE_WEB_CALLS, CITE_WEB_HOOK, CITE_WEB_DENY, CITE_WEB_PLAIN],
    apply: withWebCalls,
  },
  {
    name: "review-approved",
    from: "success-single",
    kind: "review",
    transform:
      "A reviewer's session: system/init lists Bash, Glob, Grep, Read and StructuredOutput and no skill; the result's structured_output, the StructuredOutput tool_use input and its streamed input_json_delta events are a review report with every criterion met and no finding.",
    expected:
      "The outcome is done with a valid review report: every criterion met, no finding, so the verdict code computes is approved (0019 section 5).",
    cites: [CITE_REVIEW_INIT, CITE_REVIEW_SKILLS, CITE_REVIEW_REPORT, CITE_REVIEW_PLAIN],
    apply: (lines) => asReview(lines, REVIEW_APPROVED),
  },
  {
    name: "review-blocked",
    from: "success-single",
    kind: "review",
    transform:
      "A reviewer's session as review-approved; the review report has criterion 1 unmet, a blocking correctness finding at a quoted line, a blocking test finding naming test plan entry 1 and an advisory finding.",
    expected:
      "The outcome is done with a valid review report; the verdict code computes is blocked (an unmet criterion; blocking findings once their evidence checks out), a failed round (0019 sections 5 and 6).",
    cites: [CITE_REVIEW_INIT, CITE_REVIEW_SKILLS, CITE_REVIEW_REPORT, CITE_REVIEW_PLAIN],
    apply: (lines) => asReview(lines, REVIEW_BLOCKED),
  },
  {
    name: "review-invalid",
    from: "success-single",
    kind: "review",
    transform:
      "A reviewer's session as review-approved; the result's structured_output is the source's worker report, which fails the review report schema, and the StructuredOutput tool_use input and its streamed input_json_delta events carry that same report.",
    expected:
      'No valid review report: one correction turn "report in the schema" in the same session; still invalid, it is handled as a crash: park worker-failed (0019 section 4).',
    cites: [
      CITE_REVIEW_INIT,
      CITE_REVIEW_SKILLS,
      "a worker report in a review session's structured_output is illustrative; --json-schema makes Claude Code check the report against the schema it was given",
      "the StructuredOutput tool_use input and its input_json_delta events are the result's scrubbed structured_output, so their status is kept as the result's rules keep it where a live capture redacts it in assistant and stream_event lines",
    ],
    apply: (lines) => asReview(lines, workerReport(lines)),
  },
];

/** Pure: every derived recording from its live source. */
export function deriveAll(read: (name: string) => Recording = readRecording): Derived[] {
  return TRANSFORMS.map((transform) => {
    const source = read(transform.from);
    const lines = transform.apply(source.lines);
    const meta: Meta = {
      scenario: transform.name,
      source: "derived",
      claude_code_version: source.meta.claude_code_version,
      captured_at: source.meta.captured_at,
      expected: transform.expected,
      usage_checksum: usageChecksum(stdoutOf(lines)),
      derivedFrom: transform.from,
      transform: transform.transform,
      ...(transform.cites === undefined ? {} : { cites: transform.cites }),
      ...(transform.kind === undefined ? {} : { kind: transform.kind }),
      ...(transform.testConfig === undefined
        ? {}
        : { testConfig: transform.testConfig(source.lines) }),
    };
    return { name: transform.name, lines, meta };
  });
}

/** Writes every derived recording after the secret guard. */
export function writeDerived(): void {
  const needles = machineNeedles();
  const outputs = deriveAll().map((derived) => ({
    derived,
    streamText: serializeStream(derived.lines),
    metaText: serializeMeta(derived.meta),
  }));
  // Every output passes the guard before the first file is written, so a hit writes nothing.
  for (const { derived, streamText, metaText } of outputs) {
    guardSecrets(`${derived.name}/stream.jsonl`, streamText, needles);
    guardSecrets(`${derived.name}/meta.json`, metaText, needles);
  }
  for (const { derived, streamText, metaText } of outputs) {
    writeRecording(derived.name, streamText, metaText);
    console.log(`derived ${derived.name} from ${derived.meta.derivedFrom}`);
  }
}

if (import.meta.main) writeDerived();
