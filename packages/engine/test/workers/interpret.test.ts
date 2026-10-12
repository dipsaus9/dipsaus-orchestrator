// `interpret` row by row against the 0008 section 3 table, with small hand-made lines in the
// recorded shapes; the recordings themselves run in recordings.test.ts.

import { describe, expect, it } from "bun:test";

import {
  type ClaudeParseState,
  initialState,
  interpret,
  interpretLogged,
} from "../../src/workers/claude-cli/interpret";
import { result } from "../../src/workers/claude-cli/result";
import type { HostLine, WorkerEvent, WorkerReport } from "../../src/workers/types";

const MODEL = "claude-haiku-5-5";

function out(data: unknown): HostLine {
  return { t: 0, ch: "stdout", data: JSON.stringify(data) };
}

function run(
  lines: readonly HostLine[],
  state: ClaudeParseState = initialState({ plannedModel: "haiku" }),
) {
  const events: WorkerEvent[] = [];
  let current = state;
  for (const line of lines) {
    const step = interpret(line, current);
    events.push(...step.events);
    current = step.state;
  }
  return { events, state: current };
}

const init = (extra: Record<string, unknown> = {}) =>
  out({
    type: "system",
    subtype: "init",
    session_id: "session-1",
    model: MODEL,
    claude_code_version: "2.1.296",
    permissionMode: "default",
    tools: ["Read", "StructuredOutput"],
    apiKeySource: "none",
    cwd: "${WORKDIR}",
    ...extra,
  });

const usage = {
  input_tokens: 2,
  cache_creation_input_tokens: 100,
  cache_read_input_tokens: 50,
  output_tokens: 7,
};

const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  out({
    type: "assistant",
    message: { model: MODEL, id, type: "message", role: "assistant", content, usage },
    parent_tool_use_id: null,
    session_id: "session-1",
    ...extra,
  });

const report: WorkerReport = {
  status: "done",
  criteria: [{ n: 1, met: true, evidence: "[redacted len:7]" }],
  summary: "[redacted len:18]",
  commitSubject: "[redacted len:21]",
};

const resultLine = (extra: Record<string, unknown> = {}) =>
  out({
    type: "result",
    subtype: "success",
    session_id: "session-1",
    is_error: false,
    num_turns: 2,
    terminal_reason: "completed",
    permission_denials: [],
    structured_output: report,
    modelUsage: {
      [MODEL]: {
        inputTokens: 4,
        outputTokens: 155,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 200,
      },
    },
    ...extra,
  });

const EXIT_OK: HostLine = { t: 0, ch: "exit", data: JSON.stringify({ code: 0, signal: null }) };

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe("interpret (0008 section 3)", () => {
  it("is pure: frozen input state and line, same answer twice", () => {
    const state = deepFreeze(initialState({ plannedModel: "haiku" }));
    const line = deepFreeze(init());
    const first = interpret(line, state);
    const second = interpret(line, state);
    expect(second).toEqual(first);
    expect(state.started).toBe(false);
  });

  it("system/init gives started once per process, and checks key source and model", () => {
    const { events, state } = run([init(), init(), EXIT_OK, init()]);
    expect(events).toEqual([
      {
        t: "started",
        sessionId: "session-1",
        model: MODEL,
        version: "2.1.296",
        permissionMode: "default",
        tools: ["Read", "StructuredOutput"],
      },
      expect.objectContaining({ t: "started" }) as WorkerEvent,
    ]);
    expect(state.initRejected).toBeNull();
    expect(run([init({ apiKeySource: "ANTHROPIC_API_KEY" })]).state.initRejected).toContain(
      "apiKeySource",
    );
    expect(run([init({ model: "claude-sonnet-4-5" })]).state.initRejected).toContain(
      "claude-sonnet-4-5",
    );
    // A recorded classifier switch is accepted (0008 open question 7).
    const accepted = initialState({ plannedModel: "haiku", acceptedModels: ["claude-sonnet-4-5"] });
    expect(run([init({ model: "claude-sonnet-4-5" })], accepted).state.initRejected).toBeNull();
  });

  it("assistant text and tool_use give output and activity; the report tool is not activity", () => {
    const { events } = run([
      assistant("msg-1", [{ type: "text", text: "[redacted len:5]" }]),
      assistant("msg-1", [
        { type: "tool_use", id: "toolu-1", name: "Read", input: { file_path: "${WORKDIR}/a.ts" } },
      ]),
      assistant("msg-2", [{ type: "tool_use", id: "toolu-2", name: "Agent", input: {} }]),
      assistant("msg-2", [
        { type: "tool_use", id: "toolu-3", name: "StructuredOutput", input: {} },
      ]),
      assistant("msg-3", [{ type: "text", text: "sub" }], { parent_tool_use_id: "toolu-2" }),
    ]);
    expect(events.filter((event) => event.t !== "usage")).toEqual([
      { t: "activity", kind: "text" },
      { t: "output", text: "[redacted len:5]" },
      { t: "activity", kind: "tool", tool: "Read", path: "${WORKDIR}/a.ts" },
      { t: "activity", kind: "subagent", tool: "Agent", agentId: "toolu-2" },
      { t: "activity", kind: "text", agentId: "toolu-2" },
    ]);
  });

  it("counts usage once per message id; a subagent message carries its parent tool use", () => {
    const { events, state } = run([
      assistant("msg-1", [{ type: "text", text: "a" }]),
      assistant("msg-1", [{ type: "tool_use", id: "toolu-1", name: "Read", input: {} }]),
      assistant("msg-2", [{ type: "text", text: "b" }], { parent_tool_use_id: "toolu-9" }),
    ]);
    expect(events.filter((event) => event.t === "usage")).toEqual([
      { t: "usage", messageId: "msg-1", model: MODEL, input: 2, cacheCreate: 100, cacheRead: 50 },
      {
        t: "usage",
        messageId: "msg-2",
        model: MODEL,
        agentId: "toolu-9",
        input: 2,
        cacheCreate: 100,
        cacheRead: 50,
      },
    ]);
    // Live output stays zero: per-message output is a placeholder.
    expect(state.live).toEqual({
      [MODEL]: { input: 4, output: 0, cacheCreate: 200, cacheRead: 100 },
    });
  });

  it("result gives turn with the cumulative totals replacing the live numbers", () => {
    const { events, state } = run([
      init(),
      assistant("msg-1", [{ type: "text", text: "a" }]),
      resultLine(),
    ]);
    const turn = events.find((event) => event.t === "turn");
    expect<WorkerEvent | undefined>(turn).toEqual({
      t: "turn",
      report,
      totals: { [MODEL]: { input: 4, output: 155, cacheCreate: 200, cacheRead: 100 } },
      numTurns: 2,
      terminal: "completed",
    } as WorkerEvent);
    expect(state.live).toEqual({});
  });

  it("on resume adds only the change since the stored totals", () => {
    const stored = { [MODEL]: { input: 3, output: 100, cacheCreate: 150, cacheRead: 60 } };
    const { state } = run([resultLine()], initialState({ baseline: stored }));
    expect(state.committed).toEqual({
      [MODEL]: { input: 1, output: 55, cacheCreate: 50, cacheRead: 40 },
    });
  });

  it("a crash result with zeroed totals keeps the usage of earlier assistant messages", () => {
    const zeroed = resultLine({
      subtype: "error_during_execution",
      is_error: true,
      structured_output: undefined,
      modelUsage: {
        [MODEL]: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
    const { state } = run([assistant("msg-1", [{ type: "text", text: "a" }]), zeroed]);
    expect(result(state, { code: 1, signal: null }).usage).toEqual({
      [MODEL]: { input: 2, output: 0, cacheCreate: 100, cacheRead: 50 },
    });
  });

  it("report status blocked with a question gives waiting question; with needsPermission none", () => {
    const question = run([
      resultLine({
        structured_output: { ...report, status: "blocked", question: "Which greeting?" },
      }),
    ]).events;
    expect(question).toContainEqual({ t: "waiting", on: "question", detail: "Which greeting?" });
    const permission = run([
      resultLine({
        structured_output: {
          ...report,
          status: "blocked",
          question: "May I?",
          needsPermission: { tool: "Write", action: "write /tmp/x" },
        },
      }),
    ]).events;
    expect(permission.some((event) => event.t === "waiting")).toBe(false);
  });

  it("reads the report from structured_output and validates it against the report schema", () => {
    const valid = run([resultLine()]).state.lastTurn;
    expect(valid?.report).toEqual(report);
    const invalid = run([resultLine({ structured_output: { status: "maybe" } })]).state.lastTurn;
    expect(invalid?.report).toBeNull();
    expect(invalid?.reportProblem).toContain("report schema");
    const missing = run([resultLine({ structured_output: undefined })]).state.lastTurn;
    expect(missing?.reportProblem).toBe("no structured_output");
  });

  it("permission_denied and permission_denials give one denied per tool use", () => {
    const { events } = run([
      out({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Write",
        tool_use_id: "toolu-1",
        decision_reason_type: "asyncAgent",
      }),
      resultLine({
        permission_denials: [
          { tool_name: "Write", tool_use_id: "toolu-1", tool_input: {} },
          { tool_name: "Bash", tool_use_id: "toolu-2", tool_input: {} },
        ],
      }),
    ]);
    expect(events.filter((event) => event.t === "denied")).toEqual([
      { t: "denied", tool: "Write", reason: "asyncAgent" },
      { t: "denied", tool: "Bash", reason: "permission_denials" },
    ]);
  });

  it("rate limits give limit, and a rejection or 429 also waiting plan-limit", () => {
    const info = {
      status: "allowed",
      resetsAt: 1791827400,
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.04, resetsAt: 1791827400 },
        seven_day: { utilization: 0.11 },
      },
    };
    const allowed = run([out({ type: "rate_limit_event", rate_limit_info: info })]);
    expect(allowed.events).toEqual([
      { t: "limit", status: "allowed", utilization: 0.04, resetsAt: "2026-10-12T17:50:00.000Z" },
    ]);
    expect(allowed.state.planLimit).toBeNull();

    const rejected = run([
      out({ type: "rate_limit_event", rate_limit_info: { ...info, status: "rejected" } }),
    ]);
    expect(rejected.events[1]).toEqual({
      t: "waiting",
      on: "plan-limit",
      detail: "rate limit five_hour rejected",
      until: "2026-10-12T17:50:00.000Z",
    });
    expect(result(rejected.state, { code: 0, signal: null }).outcome).toBe("plan-limit");

    const credits = run([
      out({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", errorCode: "credits_required" },
      }),
    ]);
    expect(credits.events[0]).toEqual({ t: "limit", status: "rejected", creditsRequired: true });

    const retry = run([
      out({ type: "system", subtype: "api_retry", error: "rate_limit", attempt: 1 }),
    ]);
    expect(retry.events).toEqual([
      { t: "limit", status: "rate_limit" },
      { t: "waiting", on: "plan-limit", detail: "api_retry rate_limit" },
    ]);
    // A retry is a signal only: the run continues (0017 api-retry-rate-limit).
    expect(retry.state.planLimit).toBeNull();
    expect(
      run([out({ type: "system", subtype: "api_retry", error: "overloaded" })]).events,
    ).toEqual([{ t: "waiting", on: "retry", detail: "api_retry overloaded" }]);

    const errored = run([assistant("msg-1", [], { error: "rate_limit" })]);
    expect(errored.events).toContainEqual({
      t: "waiting",
      on: "plan-limit",
      detail: "assistant error rate_limit",
    });
    expect(errored.state.planLimit).not.toBeNull();
    const status429 = run([
      resultLine({ subtype: "error_during_execution", api_error_status: 429 }),
    ]);
    expect(result(status429.state, { code: 1, signal: null }).outcome).toBe("plan-limit");
  });

  it("an account error gives waiting auth and a start failure", () => {
    const { events, state } = run([assistant("msg-1", [], { error: "billing_error" })]);
    expect(events).toContainEqual({ t: "waiting", on: "auth", detail: "billing_error" });
    expect(result(state, { code: 1, signal: null }).outcome).toBe("startFailed");
  });

  it("permission waits: the PermissionRequest hook and session_state_changed requires_action", () => {
    const hook: HostLine = {
      t: 0,
      ch: "hook",
      data: JSON.stringify({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        session_id: "session-1",
      }),
    };
    expect(run([hook]).events).toEqual([{ t: "waiting", on: "permission", detail: "Bash" }]);
    const requires = out({
      type: "system",
      subtype: "session_state_changed",
      state: "requires_action",
    });
    expect(run([requires]).events).toEqual([
      { t: "waiting", on: "permission", detail: "requires_action" },
    ]);
    const idle = out({ type: "system", subtype: "session_state_changed", state: "idle" });
    expect(run([idle]).events).toEqual([]);
  });

  it("compact_boundary gives compacted; a new model gives modelSwitched", () => {
    const compact = out({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { pre_tokens: 9000 },
    });
    expect(run([compact]).events).toEqual([{ t: "compacted", preTokens: 9000 }]);
    const switched = run([init(), init({ model: "claude-sonnet-4-5" })]).events;
    expect(switched).toContainEqual({ t: "modelSwitched", from: MODEL, to: "claude-sonnet-4-5" });
    const usageSwitch = run([
      init(),
      resultLine({
        modelUsage: {
          "claude-opus-5": {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      }),
    ]).events;
    expect(usageSwitch).toContainEqual({ t: "modelSwitched", from: MODEL, to: "claude-opus-5" });
  });

  it("holds a partial last line until it completes", () => {
    const text = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { pre_tokens: 5 },
    });
    const half = Math.floor(text.length / 2);
    const first = interpret({ t: 0, ch: "stdout", data: text.slice(0, half) }, initialState());
    expect(first.events).toEqual([]);
    expect(first.state.pending).toBe(text.slice(0, half));
    const second = interpret({ t: 1, ch: "stdout", data: `${text.slice(half)}\n` }, first.state);
    expect(second.events).toEqual([{ t: "compacted", preTokens: 5 }]);
    expect(second.state.pending).toBe("");
    // Several lines in one chunk, the last one partial.
    const chunk = `${text}\n${text}\n${text.slice(0, 10)}`;
    const many = interpret({ t: 2, ch: "stdout", data: chunk }, initialState());
    expect(many.events.length).toBe(2);
    expect(many.state.pending).toBe(text.slice(0, 10));
    // A partial line at the exit is a truncated stream.
    const ended = interpret(EXIT_OK, many.state);
    expect(ended.state.truncated).toBe(true);
    expect(result(ended.state, { code: 1, signal: null }).outcome).toBe("crashed");
  });

  it("logs an unknown message type once per run and ignores it", () => {
    const logged: string[] = [];
    let state = initialState();
    for (const data of [
      { type: "brand_new", x: 1 },
      { type: "brand_new", x: 2 },
      { type: "system", subtype: "fresh_subtype" },
    ]) {
      const step = interpretLogged(out(data), state, (message) => logged.push(message));
      expect(step.events).toEqual([]);
      state = step.state;
    }
    expect(state.unknownTypes).toEqual(["brand_new", "system/fresh_subtype"]);
    expect(logged).toEqual([
      "claude-cli: unknown stream-json message type brand_new ignored",
      "claude-cli: unknown stream-json message type system/fresh_subtype ignored",
    ]);
  });

  it("records a known line that fails its schema as a problem, without events", () => {
    const { events, state } = run([out({ type: "result", subtype: "success" })]);
    expect(events).toEqual([]);
    expect(state.problems).toEqual(["result failed its schema at session_id"]);
  });
});
