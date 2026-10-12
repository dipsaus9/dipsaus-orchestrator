// `ScriptedWorker` (0017 section 2): it plays Worker events from a list through the Worker
// interface, and a contract test refuses any script event the Claude CLI adapter could not
// produce. The adapter's own events from every recording pass the same schema (recordings.test.ts).

import { describe, expect, it } from "bun:test";

import { ClaudeWorkerEventSchema } from "../../src/workers/claude-cli/schema";
import { ScriptedWorker, ScriptError, scriptProblems } from "../../src/workers/scripted";
import type { ParseState, WorkerEvent, WorkerSpec } from "../../src/workers/types";
import { scriptedWorker, SCRIPTS } from "./scripts";

function play(worker: ScriptedWorker) {
  let state: ParseState = {};
  const events: WorkerEvent[] = [];
  for (const line of worker.lines()) {
    const step = worker.interpret(line, state);
    events.push(...step.events);
    state = step.state;
  }
  return { events, result: worker.result(state, worker.exit) };
}

describe("ScriptedWorker", () => {
  it("emits its script through interpret and derives the result", () => {
    const worker = scriptedWorker({ script: SCRIPTS["done"] ?? [] });
    const { events, result } = play(worker);
    expect(events).toEqual([...(SCRIPTS["done"] ?? [])]);
    expect(result.outcome).toBe("done");
    expect(result.usage).toEqual({
      "claude-haiku-5-5": { input: 4, output: 155, cacheCreate: 1662, cacheRead: 3682 },
    });
    expect(result.park).toBeUndefined();
  });

  it("proposes the same parks as the adapter for a blocked report and a crash", () => {
    const blocked = play(scriptedWorker({ script: SCRIPTS["blocked-question"] ?? [] })).result;
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.park).toEqual({
      reason: "ambiguous-spec",
      detail: "Which greeting should the CLI print?",
    });
    const crashed = scriptedWorker({
      script: SCRIPTS["done"] ?? [],
      exit: { code: 143, signal: null },
    });
    expect(play(crashed).result.park?.reason).toBe("worker-failed");
    const overridden = scriptedWorker({
      script: SCRIPTS["plan-limit"] ?? [],
      result: { outcome: "plan-limit", report: null },
    });
    expect(play(overridden).result.outcome).toBe("plan-limit");
  });

  it("implements the rest of the Worker interface without a process", async () => {
    const worker = scriptedWorker({ script: [] });
    expect((await worker.probe()).ok).toBe(true);
    expect(worker.plan({ workdir: "/tmp/wt" } as WorkerSpec).cwd).toBe("/tmp/wt");
    expect(worker.encode({ kind: "pause" })).toEqual([]);
    expect(worker.steered).toEqual([{ kind: "pause" }]);
    expect(worker.canResume()).toEqual({ ok: true });
  });

  describe("(contract) scripts hold only events the Claude CLI adapter can produce", () => {
    for (const [name, script] of Object.entries(SCRIPTS)) {
      it(name, () => {
        expect(scriptProblems(script, ClaudeWorkerEventSchema)).toEqual([]);
      });
    }

    it("refuses events the adapter never emits", () => {
      const impossible: unknown[] = [
        // The adapter names the subagent by its tool use id.
        { t: "activity", kind: "subagent", tool: "Agent" },
        // A waiting reason it never reports, and one without a detail.
        { t: "waiting", on: "lunch", detail: "x" },
        { t: "waiting", on: "question" },
        // Usage is never negative and always names a message.
        {
          t: "usage",
          messageId: "",
          model: "m",
          input: -1,
          output: 0,
          cacheCreate: 0,
          cacheCreate5m: 0,
          cacheCreate1h: 0,
          cacheRead: 0,
        },
        // The cache-creation parts always add up to the total.
        {
          t: "usage",
          messageId: "m-1",
          model: "m",
          input: 1,
          output: 0,
          cacheCreate: 5,
          cacheCreate5m: 1,
          cacheCreate1h: 1,
          cacheRead: 0,
        },
        // The report must fit the report schema.
        { t: "turn", report: { status: "maybe" }, totals: {}, numTurns: 1, terminal: "completed" },
        // Utilization is a 0..1 fraction; extra fields are never added.
        { t: "limit", status: "allowed", utilization: 4 },
        { t: "output", text: "x", extra: true },
        { t: "unheard-of" },
      ];
      for (const event of impossible) {
        expect(ClaudeWorkerEventSchema.safeParse(event).success).toBe(false);
      }
      const script = impossible as WorkerEvent[];
      expect(scriptProblems(script, ClaudeWorkerEventSchema).length).toBe(impossible.length);
      expect(() => new ScriptedWorker({ script, schema: ClaudeWorkerEventSchema })).toThrow(
        ScriptError,
      );
    });
  });
});
