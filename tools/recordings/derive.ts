// `bun run recordings:derive` (0017 section 2, "Scenarios"): the derived recordings are small,
// pure transforms of the committed live recordings, so they regenerate on every refresh and a
// unit test can check that the committed copies are current. Field values the docs name but no
// live run showed (for example `startup_failure_reason`) are marked in `meta.cites`.

import type { Envelope, Meta, Recording } from "./format";
import { isRecord, readRecording, serializeMeta, serializeStream, writeRecording } from "./format";
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
  readonly apply: (lines: readonly Envelope[]) => Envelope[];
  readonly testConfig?: (lines: readonly Envelope[]) => Record<string, unknown>;
}

const STALL_MS = 30 * 60 * 1000;
const CITE_RESULT =
  "Claude Code docs, Agent SDK TypeScript reference: SDKResultMessage (0008 source 4)";
const CITE_ASSISTANT_ERROR =
  "Claude Code docs, Agent SDK TypeScript reference: SDKAssistantMessage error (0008 source 4)";

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
    ...withoutReport(result),
    ...(zeroed({
      num_turns: 0,
      duration_ms: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
      usage: result.usage,
    }) as Data),
    modelUsage: {},
    permission_denials: [],
    subtype: "error_during_execution",
    is_error: true,
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
        content: [{ type: "text", text: "[redacted sha256:000000000000 len:0]" }],
      },
    };
    return [
      { t: init.t + 300, ch: "stdout", data: errored },
      { t: init.t + 310, ch: "stdout", data: failedResult(lines, {}) },
      exit(init.t + 350, 1),
    ];
  });
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
    cites: [CITE_RESULT],
    apply: (lines) =>
      replaceFirstResult(
        lines,
        (result) => ({
          ...withoutReport(result),
          subtype: "error_during_execution",
          is_error: true,
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
    cites: [CITE_RESULT, "startup_failure_reason value is illustrative; no live run showed one"],
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
    cites: [CITE_ASSISTANT_ERROR],
    apply: (lines) => assistantError(lines, "authentication_failed"),
  },
  {
    name: "start-failed-billing",
    from: "success-single",
    transform: 'An assistant message with error "billing_error", then a failed result; exit 1.',
    expected: "Outcome startFailed (0008 section 7).",
    cites: [CITE_ASSISTANT_ERROR],
    apply: (lines) => assistantError(lines, "billing_error"),
  },
  {
    name: "report-invalid",
    from: "success-single",
    transform: "The result becomes error_max_structured_output_retries without a report.",
    expected:
      'No outcome yet: one feedback turn "report in the schema", then park ambiguous-spec (0008 section 7, 0014 section 2).',
    cites: [CITE_RESULT],
    apply: (lines) =>
      replaceFirstResult(
        lines,
        (result) => ({
          ...withoutReport(result),
          subtype: "error_max_structured_output_retries",
          is_error: true,
        }),
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
    cites: [CITE_RESULT],
    apply: (lines) =>
      replaceFirstResult(
        lines,
        (result) => ({
          ...withoutReport(result),
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "prompt_too_long",
        }),
        1,
      ),
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
  for (const derived of deriveAll()) {
    const streamText = serializeStream(derived.lines);
    const metaText = serializeMeta(derived.meta);
    guardSecrets(`${derived.name}/stream.jsonl`, streamText, needles);
    guardSecrets(`${derived.name}/meta.json`, metaText, needles);
    writeRecording(derived.name, streamText, metaText);
    console.log(`derived ${derived.name} from ${derived.meta.derivedFrom}`);
  }
}

if (import.meta.main) writeDerived();
