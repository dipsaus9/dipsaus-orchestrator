// `interpret` row by row against the 0008 section 3 table, with small hand-made lines in the
// recorded shapes; the recordings themselves run in recordings.test.ts.

import { describe, expect, it } from "bun:test";

import {
  type ClaudeParseState,
  initialState,
  interpret,
  interpretLogged,
  nextSessionOptions,
  rateLimitScope,
  webLine,
} from "../../src/workers/claude-cli/interpret";
import { CHECKED_CLAUDE_VERSION, compareVersions } from "../../src/workers/claude-cli/probe";
import { result } from "../../src/workers/claude-cli/result";
import type { HostLine, WorkerEvent, WorkerReport } from "../../src/workers/types";
import { BOX_DEFAULTS } from "../../src/box/image";
import { loadRecording, recordingNames } from "./replay";

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
    const rejected = run([init({ apiKeySource: "ANTHROPIC_API_KEY" }), init()]);
    expect(rejected.state.initRejected).toContain("apiKeySource");
    // The neutral rejection comes once, before `started`, so the engine stops the worker at once.
    expect(rejected.events.map((event) => event.t)).toEqual(["initRejected", "started"]);
    expect(rejected.events[0]).toEqual({
      t: "initRejected",
      reason: "apiKeySource is ANTHROPIC_API_KEY, not none",
    });
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
      // The main agent's first message is its first model turn (DIPO-296).
      { t: "liveUsage", turns: 1, output: 0 },
      { t: "activity", kind: "tool", tool: "Read", path: "${WORKDIR}/a.ts" },
      { t: "activity", kind: "subagent", tool: "Agent", agentId: "toolu-2" },
      { t: "activity", kind: "text", agentId: "toolu-2" },
    ]);
  });

  it("a tool call carries its input beyond the path for Bash, Grep, Glob and the web tools (DIPO-83)", () => {
    const { events } = run([
      assistant("msg-1", [
        {
          type: "tool_use",
          id: "toolu-1",
          name: "Bash",
          input: { command: "bun test", timeout: 1 },
        },
        {
          type: "tool_use",
          id: "toolu-2",
          name: "Grep",
          input: { pattern: "TODO", path: "${WORKDIR}/src" },
        },
        { type: "tool_use", id: "toolu-3", name: "Glob", input: { pattern: "**/*.ts" } },
        { type: "tool_use", id: "toolu-4", name: "WebFetch", input: { url: "https://x.test" } },
        { type: "tool_use", id: "toolu-5", name: "WebSearch", input: { query: "bun" } },
        {
          type: "tool_use",
          id: "toolu-6",
          name: "Write",
          input: { file_path: "${WORKDIR}/a.ts", content: "secret body" },
        },
        { type: "tool_use", id: "toolu-7", name: "Bash", input: { command: "  " } },
      ]),
    ]);
    expect(events.filter((event) => event.t === "activity")).toEqual([
      { t: "activity", kind: "tool", tool: "Bash", input: "bun test" },
      { t: "activity", kind: "tool", tool: "Grep", path: "${WORKDIR}/src", input: "TODO" },
      { t: "activity", kind: "tool", tool: "Glob", input: "**/*.ts" },
      // A web call carries no input on its activity: its query or URL is an output line (below).
      { t: "activity", kind: "tool", tool: "WebFetch" },
      { t: "activity", kind: "tool", tool: "WebSearch" },
      // File contents and edits never travel as input; the path says what was touched.
      { t: "activity", kind: "tool", tool: "Write", path: "${WORKDIR}/a.ts" },
      { t: "activity", kind: "tool", tool: "Bash" },
    ]);
    // Every web call shows with its query or URL, whatever the opt-in for tool inputs (DIPO-164).
    expect(events.filter((event) => event.t === "output")).toEqual([
      { t: "output", text: "[web] WebFetch https://x.test\n" },
      { t: "output", text: "[web] WebSearch bun\n" },
    ]);
  });

  it("keeps a web call's query or URL whole on one line: the engine redacts it before it cuts it", () => {
    const url = `https://x.test/?q=${"a".repeat(500)}`;
    expect(webLine("WebFetch", `  ${url}\n`)).toBe(`[web] WebFetch ${url}\n`);
    expect(webLine("WebSearch", "bun\n\ttest")).toBe("[web] WebSearch bun test\n");
    expect(webLine("WebSearch", undefined)).toBe("[web] WebSearch\n");
  });

  it("counts usage once per message id; a subagent message carries its parent tool use", () => {
    const { events, state } = run([
      assistant("msg-1", [{ type: "text", text: "a" }]),
      assistant("msg-1", [{ type: "tool_use", id: "toolu-1", name: "Read", input: {} }]),
      assistant("msg-2", [{ type: "text", text: "b" }], { parent_tool_use_id: "toolu-9" }),
    ]);
    expect(events.filter((event) => event.t === "usage")).toEqual([
      {
        t: "usage",
        messageId: "msg-1",
        model: MODEL,
        input: 2,
        output: 7,
        cacheCreate: 100,
        cacheCreate5m: 100,
        cacheCreate1h: 0,
        cacheRead: 50,
      },
      {
        t: "usage",
        messageId: "msg-2",
        model: MODEL,
        agentId: "toolu-9",
        input: 2,
        output: 7,
        cacheCreate: 100,
        cacheCreate5m: 100,
        cacheCreate1h: 0,
        cacheRead: 50,
      },
    ]);
    // Live output stays zero: per-message output is a placeholder.
    expect(state.live).toEqual({
      [MODEL]: { input: 4, output: 0, cacheCreate: 200, cacheRead: 100 },
    });
  });

  it("usage splits cache creation into 5 minute and 1 hour parts and keeps message output", () => {
    const split = {
      ...usage,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 },
    };
    const line = out({
      type: "assistant",
      message: {
        model: MODEL,
        id: "msg-3",
        type: "message",
        role: "assistant",
        content: [],
        usage: split,
      },
      parent_tool_use_id: null,
      session_id: "session-1",
    });
    const { events } = run([line]);
    expect(events).toEqual([
      {
        t: "usage",
        messageId: "msg-3",
        model: MODEL,
        input: 2,
        output: 7,
        cacheCreate: 100,
        cacheCreate5m: 30,
        cacheCreate1h: 70,
        cacheRead: 50,
      },
      { t: "liveUsage", turns: 1, output: 0 },
    ]);
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

  it("report status blocked with a question gives waiting question; without one none", () => {
    const question = run([
      resultLine({
        structured_output: { ...report, status: "blocked", question: "Which greeting?" },
      }),
    ]).events;
    expect(question).toContainEqual({ t: "waiting", on: "question", detail: "Which greeting?" });
    const reason = run([
      resultLine({ structured_output: { ...report, status: "blocked" } }),
    ]).events;
    expect(reason.some((event) => event.t === "waiting")).toBe(false);
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
      {
        t: "limit",
        status: "allowed",
        utilization: 0.04,
        resetsAt: "2026-10-12T17:50:00.000Z",
        scope: "session",
      },
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
    expect(run([{ ...hook, end: 512 }]).events).toEqual([
      { t: "hook", hook: { kind: "permissionRequest", id: 512, tool: "Bash", input: "" } },
      { t: "waiting", on: "permission", detail: "Bash" },
    ]);
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
    // Without a planned model every change of the init model is reported.
    const switched = run([init(), init({ model: "claude-sonnet-4-5" })], initialState()).events;
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

  it("logs an unknown message type once per run and drops it, each line a dropped drift", () => {
    const logged: string[] = [];
    let state = initialState();
    const drifts: WorkerEvent[] = [];
    for (const data of [
      { type: "brand_new", x: 1 },
      { type: "brand_new", x: 2 },
      { type: "system", subtype: "fresh_subtype" },
    ]) {
      const step = interpretLogged(out(data), state, (message) => logged.push(message));
      drifts.push(...step.events);
      state = step.state;
    }
    // DIPO-315: every dropped line is counted, not only the first of its type.
    expect(drifts).toEqual([
      {
        t: "streamDrift",
        kind: "dropped",
        detail: "message type brand_new is not known, so it was dropped",
        worker: "Claude Code (version not reported yet)",
      },
      {
        t: "streamDrift",
        kind: "dropped",
        detail: "message type brand_new is not known, so it was dropped",
        worker: "Claude Code (version not reported yet)",
      },
      {
        t: "streamDrift",
        kind: "dropped",
        detail: "message type system/fresh_subtype is not known, so it was dropped",
        worker: "Claude Code (version not reported yet)",
      },
    ]);
    expect(state.unknownTypes).toEqual(["brand_new", "system/fresh_subtype"]);
    expect(logged).toEqual([
      "claude-cli: unknown stream-json message type brand_new ignored",
      "claude-cli: unknown stream-json message type system/fresh_subtype ignored",
    ]);
  });

  it("records a known line that fails its schema as a problem and a drift event (DIPO-315)", () => {
    const { events, state } = run([
      init(),
      out({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: "x" } }),
    ]);
    expect(events.filter((event) => event.t === "streamDrift")).toEqual([
      {
        t: "streamDrift",
        kind: "schema",
        detail: "system/compact_boundary failed its schema at compact_metadata.pre_tokens",
        worker: `Claude Code ${state.version}`,
      },
    ]);
    expect(state.problems).toEqual([
      "system/compact_boundary failed its schema at compact_metadata.pre_tokens",
    ]);
  });

  it("makes a result whose schema fails a usage drift, with no turn (DIPO-315)", () => {
    const { events, state } = run([out({ type: "result", subtype: "success" })]);
    expect(events).toEqual([
      {
        t: "streamDrift",
        kind: "usage",
        detail: "result failed its schema at session_id",
        worker: "Claude Code (version not reported yet)",
      },
    ]);
    expect(state.problems).toEqual(["result failed its schema at session_id"]);
  });

  it("makes an unparseable stdout line and a hook line that fails its schema schema drifts", () => {
    const { events } = run([
      { t: 1, ch: "stdout", data: "{not json\n" },
      { t: 2, ch: "hook", data: "{also not json" },
    ]);
    expect(events.map((event) => (event.t === "streamDrift" ? event.kind : event.t))).toEqual([
      "schema",
      "schema",
    ]);
  });
});

const SONNET = "claude-sonnet-4-5";
const on = (model: string, id: string, extra: Record<string, unknown> = {}) =>
  out({
    type: "assistant",
    message: { model, id, type: "message", role: "assistant", content: [], usage },
    parent_tool_use_id: null,
    session_id: "session-1",
    ...extra,
  });
const problemOf = (lines: readonly HostLine[]) =>
  run(lines).events.find(
    (event): event is Extract<WorkerEvent, { t: "turn" }> => event.t === "turn",
  )?.problem;

describe("worker outcomes (DIPO-51)", () => {
  it("records a classifier switch once, and the next system/init on it is accepted", () => {
    const { events, state } = run([
      init(),
      on(SONNET, "msg-1"),
      on(SONNET, "msg-2"),
      // A subagent on another model is not a switch of the main agent.
      on("claude-opus-5", "msg-3", { parent_tool_use_id: "toolu-1" }),
      init({ model: SONNET }),
    ]);
    expect(events.filter((event) => event.t === "modelSwitched")).toEqual([
      { t: "modelSwitched", from: MODEL, to: SONNET },
    ]);
    expect(events.some((event) => event.t === "initRejected")).toBe(false);
    expect(state.acceptedModels).toEqual([SONNET]);
    // A model only a result shows is recorded too.
    const viaResult = run([
      init(),
      resultLine({
        modelUsage: {
          [SONNET]: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      }),
    ]);
    expect(viaResult.state.acceptedModels).toEqual([SONNET]);
  });

  it("a resumed session inherits the recorded switches, so neither init nor a message repeats it", () => {
    const first = run([init(), on(SONNET, "msg-1"), EXIT_OK]).state;
    const resumed = initialState(nextSessionOptions(first, true, "haiku"));
    const { events } = run([init({ model: SONNET }), on(SONNET, "msg-2")], resumed);
    expect(events.some((event) => event.t === "modelSwitched" || event.t === "initRejected")).toBe(
      false,
    );
  });

  it("names what was wrong with a turn", () => {
    expect(problemOf([init(), resultLine()])).toBeUndefined();
    expect(problemOf([init(), resultLine({ structured_output: undefined })])).toEqual({
      kind: "report",
      detail: "no structured_output",
    });
    expect(problemOf([init(), resultLine({ structured_output: { status: "done" } })])?.detail).toBe(
      "structured_output fails the report schema",
    );
    expect(
      problemOf([
        init(),
        resultLine({ subtype: "error_max_structured_output_retries", structured_output: null }),
      ]),
    ).toEqual({ kind: "report", detail: "error_max_structured_output_retries" });
    expect(
      problemOf([
        init(),
        resultLine({ subtype: "error_during_execution", terminal_reason: "prompt_too_long" }),
      ]),
    ).toEqual({ kind: "contextFull", detail: "prompt_too_long: the context is full" });
    expect(
      problemOf([
        init(),
        on(MODEL, "msg-1", { error: "server_error" }),
        resultLine({ subtype: "error_during_execution", terminal_reason: "aborted_streaming" }),
      ]),
    ).toEqual({
      kind: "error",
      detail: "error_during_execution (aborted_streaming), last error server_error",
    });
    expect(
      problemOf([
        init(),
        resultLine({ subtype: "error_during_execution", startup_failure_reason: "sandbox" }),
      ]),
    ).toEqual({ kind: "startFailed", detail: "startup_failure_reason sandbox" });
    expect(problemOf([init(), resultLine({ subtype: "error_max_turns" })])).toBeUndefined();
  });

  it("a turn ended by a 429 is a rejected plan limit", () => {
    const { events } = run([
      init(),
      resultLine({ subtype: "error_during_execution", api_error_status: 429 }),
    ]);
    const limit = events.findIndex((event) => event.t === "limit");
    const turn = events.findIndex((event) => event.t === "turn");
    expect(events[limit]).toEqual({ t: "limit", status: "rejected" });
    expect(limit).toBeLessThan(turn);
    expect((events[turn] as Extract<WorkerEvent, { t: "turn" }>).problem?.kind).toBe("planLimit");
  });

  it("tracks the main agent's context tokens and the context window", () => {
    const { state } = run([
      init(),
      on(MODEL, "msg-1"),
      on(SONNET, "msg-2", { parent_tool_use_id: "toolu-1" }),
      resultLine({
        modelUsage: {
          [MODEL]: {
            inputTokens: 4,
            outputTokens: 155,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 200,
            contextWindow: 200_000,
          },
        },
      }),
    ]);
    expect(state.contextTokens).toBe(usage.input_tokens + 100 + 50);
    expect(state.contextWindow).toBe(200_000);
  });

  it("counts a resumed session's spend once whether the CLI restores the floor or the floor plus later spend", () => {
    const usageOf = (i: number, o: number, c: number, r: number, cost: number) =>
      resultLine({
        modelUsage: {
          [MODEL]: {
            inputTokens: i,
            outputTokens: o,
            cacheCreationInputTokens: c,
            cacheReadInputTokens: r,
            costUSD: cost,
          },
        },
      });
    // The previous process: totals at its turn end, then one message (live 2/0/100/50).
    const previous = run([
      init(),
      usageOf(4, 155, 200, 100, 0.01),
      on(MODEL, "msg-9"),
      EXIT_OK,
    ]).state;
    const resumed = () => initialState(nextSessionOptions(previous, true, "haiku"));
    // The resumed process spends one message (2/100/50) and 20 output tokens.
    const spent = { [MODEL]: { input: 2, output: 20, cacheCreate: 100, cacheRead: 50 } };
    // Restores only the floor (the previous turn totals).
    const floorOnly = run(
      [init(), on(MODEL, "msg-10"), usageOf(4 + 2, 155 + 20, 200 + 100, 100 + 50, 0.012)],
      resumed(),
    ).state;
    expect(floorOnly.committed).toEqual(spent);
    expect(floorOnly.costCommitted?.[MODEL]).toBeCloseTo(0.002, 9);
    // Restores the floor plus the previous process's spend after its turn end.
    const withLive = run(
      [init(), on(MODEL, "msg-10"), usageOf(6 + 2, 155 + 20, 300 + 100, 150 + 50, 0.013)],
      resumed(),
    ).state;
    expect(withLive.committed).toEqual(spent);
    // That later spend was never priced by a result, so its cost counts now.
    expect(withLive.costCommitted?.[MODEL]).toBeCloseTo(0.003, 9);
  });

  it("a resume tells restored spend from a restarted count, per field", () => {
    const previous = run([init(), resultLine(), on(MODEL, "msg-9"), EXIT_OK]).state;
    // The previous process counted its turn totals plus one message after them.
    const options = nextSessionOptions(previous, true, "haiku");
    expect(options.restoredFloor).toEqual({
      [MODEL]: { input: 4, output: 155, cacheCreate: 200, cacheRead: 100 },
    });
    expect(options.baseline).toEqual({
      [MODEL]: { input: 6, output: 155, cacheCreate: 300, cacheRead: 150 },
    });
    const resumed = initialState(options);
    const totals = (fields: { i: number; o: number; c: number; r: number }) =>
      resultLine({
        modelUsage: {
          [MODEL]: {
            inputTokens: fields.i,
            outputTokens: fields.o,
            cacheCreationInputTokens: fields.c,
            cacheReadInputTokens: fields.r,
          },
        },
      });
    // input above the baseline: the rise; output between floor and baseline: live (zero);
    // cache creation below the floor: all of it; cache read between: live.
    const step = run(
      [init(), on(MODEL, "msg-10"), totals({ i: 10, o: 155, c: 50, r: 120 })],
      resumed,
    );
    expect(step.state.committed).toEqual({
      [MODEL]: { input: 4, output: 0, cacheCreate: 50, cacheRead: 50 },
    });
    // The floor applies to the first turn end only.
    expect(step.state.restoredFloor).toBeUndefined();
    // A new session (not a resume) starts its counts at zero and keeps only the switches.
    expect(nextSessionOptions(previous, false, "haiku")).toEqual({
      plannedModel: "haiku",
      acceptedModels: [],
    });
  });
});

describe("plan-limit scopes (DIPO-61)", () => {
  it("names the session, weekly and model-family windows, and nothing else", () => {
    expect(rateLimitScope("five_hour")).toBe("session");
    expect(rateLimitScope("seven_day")).toBe("weekly");
    expect(rateLimitScope("seven_day_opus")).toBe("model:opus");
    expect(rateLimitScope("seven_day_sonnet")).toBe("model:sonnet");
    expect(rateLimitScope("overage")).toBeUndefined();
    expect(rateLimitScope(undefined)).toBeUndefined();
  });
});

describe("stream drift and the checked version (DIPO-315)", () => {
  it("puts a usage drift ahead of a completed turn whose result reports no token usage", () => {
    const { events } = run([init(), resultLine({ modelUsage: {} })]);
    const kinds = events.map((event) => event.t);
    expect(kinds.indexOf("streamDrift")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("streamDrift")).toBeLessThan(kinds.indexOf("turn"));
    expect(events.find((event) => event.t === "streamDrift")).toEqual({
      t: "streamDrift",
      kind: "usage",
      detail: "a completed turn's result reports no token usage (completed)",
      worker: "Claude Code 2.1.296",
    });
    // All-zero totals are no usage either.
    const zero = run([
      init(),
      resultLine({
        modelUsage: {
          [MODEL]: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      }),
    ]);
    expect(zero.events.filter((event) => event.t === "streamDrift")).toHaveLength(1);
  });

  it("does not drift on an aborted or failed turn without usage, nor on a turn with usage", () => {
    const aborted = run([
      init(),
      resultLine({ modelUsage: {}, terminal_reason: "aborted_streaming" }),
    ]);
    const failed = run([
      init(),
      resultLine({ modelUsage: {}, subtype: "error_during_execution", terminal_reason: "error" }),
    ]);
    const counted = run([init(), resultLine()]);
    for (const replayed of [aborted, failed, counted]) {
      expect(replayed.events.filter((event) => event.t === "streamDrift")).toEqual([]);
    }
  });

  it("notes a Claude Code newer than the checked one at its start, once per process", () => {
    const newer = run([
      init({ claude_code_version: "2.1.400" }),
      init({ claude_code_version: "2.1.400" }),
    ]);
    expect(newer.events.filter((event) => event.t === "newerVersion")).toEqual([
      {
        t: "newerVersion",
        worker: "Claude Code",
        version: "2.1.400",
        checked: CHECKED_CLAUDE_VERSION,
      },
    ]);
    for (const version of [CHECKED_CLAUDE_VERSION, "2.1.296"]) {
      const quiet = run([init({ claude_code_version: version })]);
      expect(quiet.events.filter((event) => event.t === "newerVersion")).toEqual([]);
    }
  });

  it("checks the box image's Claude Code and is at least every recording's version", () => {
    expect(CHECKED_CLAUDE_VERSION).toBe(BOX_DEFAULTS.claudeCode);
    for (const name of recordingNames()) {
      const recorded = loadRecording(name).meta["claude_code_version"];
      if (typeof recorded !== "string") continue;
      expect(compareVersions(recorded, CHECKED_CLAUDE_VERSION)).toBeLessThanOrEqual(0);
    }
  });
});
