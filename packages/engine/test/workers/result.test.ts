// `result(state, exit)` rows of 0008 section 7 that no recording shows, from synthetic states, and
// the usage of an aborted turn whose result leaves its own spend out.

import { describe, expect, it } from "bun:test";

import {
  type ClaudeParseState,
  initialState,
  interpret,
} from "../../src/workers/claude-cli/interpret";
import { result } from "../../src/workers/claude-cli/result";
import type { HostLine, WorkerReport } from "../../src/workers/types";

const MODEL = "claude-haiku-5-5";
const OK = { code: 0, signal: null };

function out(data: unknown): HostLine {
  return { t: 0, ch: "stdout", data: JSON.stringify(data) };
}

function feed(lines: readonly HostLine[], state: ClaudeParseState = initialState()) {
  let current = state;
  for (const line of lines) current = interpret(line, current).state;
  return current;
}

const report: WorkerReport = {
  status: "done",
  criteria: [{ n: 1, met: true, evidence: "[redacted len:7]" }],
  summary: "[redacted len:18]",
  commitSubject: "[redacted len:21]",
};

function usageOf(input: number, output: number, cacheCreate: number, cacheRead: number) {
  return {
    [MODEL]: {
      inputTokens: input,
      outputTokens: output,
      cacheCreationInputTokens: cacheCreate,
      cacheReadInputTokens: cacheRead,
    },
  };
}

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
    modelUsage: usageOf(4, 155, 200, 100),
    ...extra,
  });

const assistant = (id: string, input: number, cacheCreate: number, cacheRead: number) =>
  out({
    type: "assistant",
    message: {
      model: MODEL,
      id,
      content: [],
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
        output_tokens: 1,
      },
    },
    parent_tool_use_id: null,
  });

describe("result rows without a recording (0008 section 7)", () => {
  it("a rejected rate_limit_event gives plan-limit with no park", () => {
    const state = feed([
      out({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1791827400 },
      }),
      resultLine({ structured_output: undefined }),
    ]);
    const res = result(state, OK);
    expect(res.outcome).toBe("plan-limit");
    expect(res.park).toBeUndefined();
    expect(res.resumable).toBe(true);
  });

  it("a turn ended by a 429 gives plan-limit with no park", () => {
    const state = feed([
      resultLine({
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "error",
        api_error_status: 429,
        structured_output: undefined,
      }),
    ]);
    const res = result(state, { code: 1, signal: null });
    expect(res.outcome).toBe("plan-limit");
    expect(res.park).toBeUndefined();
  });

  it("error_max_structured_output_retries: blocked, no report, report feedback before ambiguous-spec", () => {
    const state = feed([
      resultLine({
        subtype: "error_max_structured_output_retries",
        is_error: true,
        terminal_reason: "error",
        structured_output: undefined,
      }),
    ]);
    const res = result(state, { code: 1, signal: null });
    expect(res.outcome).toBe("blocked");
    expect(res.report).toBeNull();
    expect(res.park?.reason).toBe("ambiguous-spec");
    expect(res.retry).toBe("report-feedback");
  });

  it("prompt_too_long: a handoff before budget-exceeded", () => {
    const state = feed([
      resultLine({
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "prompt_too_long",
        structured_output: undefined,
      }),
    ]);
    const res = result(state, { code: 1, signal: null });
    expect(res.park?.reason).toBe("budget-exceeded");
    expect(res.retry).toBe("handoff");
  });

  it("an inferred signal decides only with exit 143; exit 1 after a sent signal reads as exit 1 (DIPO-88)", () => {
    const state = feed([
      resultLine({
        subtype: "error_max_structured_output_retries",
        is_error: true,
        terminal_reason: "error",
        structured_output: undefined,
      }),
    ]);
    const after = result(state, { code: 1, signal: "SIGTERM", signalInferred: true });
    expect(after).toEqual(result(state, { code: 1, signal: null }));
    expect(after.outcome).toBe("blocked");
    const stopped = result(state, { code: 143, signal: "SIGTERM", signalInferred: true });
    expect(stopped.outcome).toBe("crashed");
    expect(stopped.park?.detail).toBe("signal SIGTERM with no intent recorded");
  });

  it("a done report with a nonzero exit is a crash that keeps the report", () => {
    const res = result(feed([resultLine()]), { code: 1, signal: null });
    expect(res.outcome).toBe("crashed");
    expect(res.report).toEqual(report);
    expect(res.park?.reason).toBe("worker-failed");
    expect(res.retry).toBeUndefined();
    expect(result(feed([resultLine()]), OK)).toMatchObject({ outcome: "done" });
  });
});

describe("usage of a turn that did not complete", () => {
  it("an aborted second turn whose totals leave its own spend out keeps its live usage", () => {
    const state = feed(
      [
        assistant("msg-1", 2, 100, 50),
        resultLine({ modelUsage: usageOf(2, 40, 100, 50) }),
        // The second turn is interrupted; its result repeats the first turn's cumulative totals.
        assistant("msg-2", 3, 70, 150),
        resultLine({
          terminal_reason: "aborted_streaming",
          structured_output: undefined,
          modelUsage: usageOf(2, 40, 100, 50),
        }),
      ],
      initialState(),
    );
    expect(result(state, OK).usage).toEqual({
      [MODEL]: { input: 5, output: 40, cacheCreate: 170, cacheRead: 200 },
    });
  });

  it("an aborted turn whose totals do include its spend is not counted twice", () => {
    const state = feed([
      assistant("msg-1", 2, 100, 50),
      resultLine({ modelUsage: usageOf(2, 40, 100, 50) }),
      assistant("msg-2", 3, 70, 150),
      resultLine({
        terminal_reason: "aborted_streaming",
        structured_output: undefined,
        modelUsage: usageOf(5, 60, 170, 200),
      }),
    ]);
    expect(result(state, OK).usage).toEqual({
      [MODEL]: { input: 5, output: 60, cacheCreate: 170, cacheRead: 200 },
    });
  });

  it("a completed turn still replaces the live numbers with the reported change", () => {
    const state = feed([
      assistant("msg-1", 9, 900, 900),
      resultLine({ modelUsage: usageOf(2, 40, 100, 50) }),
    ]);
    expect(result(state, OK).usage).toEqual({
      [MODEL]: { input: 2, output: 40, cacheCreate: 100, cacheRead: 50 },
    });
  });
});
