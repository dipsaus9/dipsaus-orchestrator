// `bun run recordings:derive` (0017 section 2, "Scenarios"): the derived recordings are small,
// pure transforms of the committed live recordings, so they regenerate on every refresh and a
// unit test can check that the committed copies are current. Field values the docs name but no
// live run showed (for example `startup_failure_reason`) are marked in `meta.cites`.

import { refusalText } from "../../packages/engine/src/index";
import { WEB_ENV_FILE, WEB_ENV_KEY, WEB_QUERY, WEB_REFUSED_URL, WEB_URL } from "./scenarios";

import type { Envelope, Meta, Recording } from "./format";
import { isRecord, readRecording, serializeMeta, serializeStream, writeRecording } from "./format";
import { redact, WEB_INPUT_FIELDS } from "./scrub";
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

// The review kind (0019 sections 4 and 5, DIPO-145). The live `review-*-live` captures (Claude
// Code 2.1.302, 2026-10-19) exist beside these; the derived review recordings stay the live
// `success-single` session with the reviewer's system/init (its four tools, no skill, no slash
// command) and an illustrative review report, kept readable for the replay tests. The derived
// `review-invalid` is the only invalid review report: the live `review-invalid-live` returned a
// valid one.

/** The tools a reviewer's system/init lists: the four of 0019 section 4 and the report tool. */
const REVIEW_INIT_TOOLS = ["Bash", "Glob", "Grep", "Read", "StructuredOutput"];

const CITE_REVIEW_INIT =
  "system/init tools Bash, Glob, Grep, Read and StructuredOutput are those --tools Read,Glob,Grep,Bash asks for, as the live review-*-live captures (Claude Code 2.1.302, 2026-10-19) list them, with skills [] and slash_commands [] (0019 section 4)";
const CITE_REVIEW_SKILLS =
  "system/init skills [] and slash_commands [] as the live safety-slash-skill recording showed under --disable-slash-commands";
const CITE_REVIEW_REPORT =
  "structured_output, the StructuredOutput tool_use input and its input_json_delta stream events carry one illustrative ReviewReport (0019 section 5). The live review-*-live captures (Claude Code 2.1.302, 2026-10-19) confirm the report travels in all three places; a live capture keeps only structured_output's decision fields (criteria status, finding severity and kind) and numbers, and redacts every string of the tool_use input and every partial_json delta";
// The replay tests check the findings' file, line and quote, and a review judge checks a quote
// against the code tree (0019 section 5), so the injected text stays readable.
const CITE_REVIEW_PLAIN =
  "the review report's text fields (evidence, text, file, quote, summary) are left unredacted on purpose, where a live capture redacts them (tools/recordings/scrub.ts; the review-*-live captures show it): they are fixed illustrative text, not a live session's, and the replay tests read them";

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

// The web tools (0020 section 11b, DIPO-164). The live `web` capture (Claude Code 2.1.302,
// 2026-10-19) exists beside this one and confirmed the query and URLs on the tool_use blocks and
// PreToolUse hook lines, the hook's deny as an error tool_result, the refused call in
// permission_denials and the result's web counters. The derived `web-calls` stays the live
// `success-tools-subagent` session cut to its first turn: its init, three tool calls built on its
// Read call, and its report turn; its cites name where the live capture differs.

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
  "system/init tools lists WebFetch and WebSearch besides the six of the developer role (0020 section 11b); the live `web` capture (Claude Code 2.1.302, 2026-10-19) lists WebFetch and WebSearch beside the Read and StructuredOutput its scenario asked for";
const CITE_WEB_CALLS =
  "the WebSearch, WebFetch and refused WebFetch assistant tool_use blocks, their tool results and their message ids are built on the live Read call of the source, one call per message; in the live `web` capture (Claude Code 2.1.302, 2026-10-19) the three calls share one message id, the refused call's result comes first, and each user message also carries tool_use_result and tool_result_meta, which this recording drops";
const CITE_WEB_HOOK =
  "the PreToolUse hook payloads (tool_name, tool_use_id, tool_input cut to the url or query as dipo hook PreToolUse --gate relays it) match the live `web` capture (Claude Code 2.1.302, 2026-10-19), which also carries prompt_id and the PostToolUse lines of the two calls that ran; this recording has neither";
const CITE_WEB_DENY =
  "the refused call's tool_result (is_error, the engine's reason naming .env and FIXTURE_API_KEY and not the value) follows the live `web` capture (Claude Code 2.1.302, 2026-10-19), where the deny travels as the hook's stdout with exit 0 (hook_response outcome success) and the tool_result text is the reason behind a `PreToolUse:WebFetch hook error: ` prefix this recording leaves out. A live capture keeps the error result of a web call through the web rules (WEB_INPUT_FIELDS, tools/recordings/scrub.ts); the successful results are redacted here as a live capture redacts them";
const CITE_WEB_PLAIN =
  "the query and url of the three calls (tool_use input, wire_tool_inputs and the hook payloads' tool_input) are the web scenario's fixed synthetic text, kept as a live capture keeps them through the web rules (WEB_INPUT_FIELDS, tools/recordings/scrub.ts); the WebFetch prompts are redacted as a live capture redacts them";
const CITE_WEB_COUNTERS =
  "the result's usage.server_tool_use (web_search_requests 0, web_fetch_requests 0) and modelUsage webSearchRequests 1 are what the live `web` capture (Claude Code 2.1.302) reports for one WebSearch, one WebFetch and one refused WebFetch: server_tool_use counts none of them, modelUsage counts the search only";
const CITE_WEB_DENIALS =
  "the result's permission_denials holds the refused WebFetch (tool_name, tool_use_id, and tool_input with url and prompt redacted), as the live `web` capture (Claude Code 2.1.302, 2026-10-19) shows a PreToolUse hook deny there";
const CITE_WEB_REPORT =
  "the report turn (thinking, the StructuredOutput call, num_turns, durations and usage totals, and the report with status blocked and a question about the source's background subagent) is the source's live first turn, kept as captured on purpose so the report and usage stay live data; the source's subagent_stats is dropped, as this session starts no subagent";

/** The prompt of the refused WebFetch; a live capture redacts it. */
const WEB_REFUSED_PROMPT = "Read the page.";

/** One web call: the assistant tool_use, the PreToolUse hook payload and the tool result. */
function webCall(
  read: { readonly assistant: Envelope; readonly user: Envelope },
  call: {
    readonly n: number;
    readonly t: number;
    readonly tool: "WebSearch" | "WebFetch";
    /** The query or URL, kept by the web rules. */
    readonly target: string;
    /** A WebFetch's prompt, redacted as a live capture redacts it. */
    readonly prompt?: string;
    /** The tool result: redacted unless the call was refused (an error result is kept). */
    readonly result: string;
    readonly refused?: boolean;
  },
): Envelope[] {
  const id = `toolu-w${call.n}`;
  const field = WEB_INPUT_FIELDS[call.tool] ?? "url";
  const input: Data = {
    [field]: call.target,
    ...(call.prompt === undefined ? {} : { prompt: redact(call.prompt) }),
  };
  const assistant = clone(read.assistant.data as Data);
  const message = clone(assistant.message as Data);
  assistant.message = {
    ...message,
    id: `msg-w${call.n}`,
    content: [{ type: "tool_use", id, name: call.tool, input, caller: { type: "direct" } }],
  };
  assistant.wire_tool_inputs = { [id]: input };
  assistant.uuid = `uuid-w${call.n}a`;
  assistant.request_id = `req-w${call.n}`;
  const user = clone(read.user.data as Data);
  user.message = {
    role: "user",
    content: [
      {
        tool_use_id: id,
        type: "tool_result",
        content: call.refused === true ? call.result : redact(call.result),
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
        // `dipo hook PreToolUse --gate` relays only the query or URL of the tool input.
        tool_input: { [field]: call.target },
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
      target: WEB_QUERY,
      result: `Web search results for "${WEB_QUERY}": 1 result.`,
    }),
    webCall(read, {
      n: 2,
      t: t0 + 1_000,
      tool: "WebFetch",
      target: WEB_URL,
      prompt: "Summarise how to run a single test file.",
      result: "bun test runs files matching *.test.ts; pass a path to run one file.",
    }),
    webCall(read, {
      n: 3,
      t: t0 + 2_000,
      tool: "WebFetch",
      target: WEB_REFUSED_URL,
      prompt: WEB_REFUSED_PROMPT,
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
    ...tail.map((line) => (isType(line, "result") ? withWebResult(line) : line)),
    exit(last + 60, 0),
  ];
}

function withInitTools(line: Envelope): Envelope {
  return { ...line, data: { ...clone(line.data as Data), tools: WEB_INIT_TOOLS } };
}

/**
 * The source's first result with the web counters of the live `web` capture and its subagent
 * leftovers dropped: `usage.server_tool_use` counts no call and `modelUsage` counts the search
 * (`webSearchRequests` 1), the refused fetch in `permission_denials` (its input redacted, as a
 * live capture redacts it), and no `subagent_stats`, as this session started no subagent.
 */
function withWebResult(line: Envelope): Envelope {
  const result = clone(line.data as Data);
  const usage = result.usage as Data;
  usage.server_tool_use = { web_search_requests: 0, web_fetch_requests: 0 };
  for (const entry of Object.values(result.modelUsage as Record<string, Data>)) {
    entry.webSearchRequests = 1;
  }
  result.permission_denials = [
    {
      tool_name: "WebFetch",
      tool_use_id: "toolu-w3",
      tool_input: { url: redact(WEB_REFUSED_URL), prompt: redact(WEB_REFUSED_PROMPT) },
    },
  ];
  delete result.subagent_stats;
  return { ...line, data: result };
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
    cites: [
      CITE_WEB_INIT,
      CITE_WEB_CALLS,
      CITE_WEB_HOOK,
      CITE_WEB_DENY,
      CITE_WEB_PLAIN,
      CITE_WEB_COUNTERS,
      CITE_WEB_DENIALS,
      CITE_WEB_REPORT,
    ],
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
