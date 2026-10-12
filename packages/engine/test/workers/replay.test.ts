// Steering through the fake process with real recordings (0017 section 2, "Replay"): SIGINT jumps
// to the recorded post-interrupt tail, SIGTERM ends with exit 143 and no result, stdin writes are
// recorded, and the manual clock moves by the recorded deltas.

import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { encode } from "../../src/workers/claude-cli/encode";
import { loadRecording, replay } from "./replay";

describe("replaying recordings through the fake process", () => {
  it("interrupt: SIGINT jumps to the recorded tail, the turn ends with a result, exit 0", async () => {
    const recording = loadRecording("interrupt");
    const full = await replay(recording);
    const lastLine = recording.lines[recording.lines.length - 1];
    expect(full.elapsed).toBe((lastLine?.t ?? 0) - 1);

    const sigint = recording.meta.steering?.find((steer) => steer.op === "signal")?.t ?? 0;
    const init = recording.lines.find(
      (line) => line.ch === "stdout" && (line.data as { subtype?: string }).subtype === "init",
    );
    const run = await replay(recording, {
      beforeRead: (child, chunks) => {
        // The first two stdout lines are session_state_changed and system/init.
        if (chunks === 2) child.kill("SIGINT");
      },
    });
    expect(run.fake.processes[0]?.signals).toEqual(["SIGINT"]);
    const turn = run.events.find((event) => event.t === "turn");
    expect(turn?.t === "turn" && turn.terminal).toBe("aborted_streaming");
    expect(run.exit).toEqual({ code: 0, signal: null });
    // Time to the init, then only the recorded time after the signal.
    expect(run.elapsed).toBe((init?.t ?? 0) - 1 + ((lastLine?.t ?? 0) - sigint));
    expect(run.lines.length).toBeLessThan(full.lines.length);
  });

  it("SIGTERM: exit 143 with no result; the outcome is crashed with usage recovered", async () => {
    const recording = loadRecording("success-tools-subagent");
    const firstResult = recording.lines.findIndex(
      (line) => line.ch === "stdout" && (line.data as { type?: string }).type === "result",
    );
    const before = recording.lines
      .slice(0, firstResult)
      .filter((line) => line.ch === "stdout").length;
    const run = await replay(recording, {
      beforeRead: (child, chunks) => {
        if (chunks === before - 2) child.kill("SIGTERM");
      },
    });
    expect(run.exit).toEqual({ code: 143, signal: null });
    expect(run.events.some((event) => event.t === "turn")).toBe(false);
    expect(run.result.outcome).toBe("crashed");
    expect(run.result.park?.reason).toBe("worker-failed");
    expect(Object.keys(run.result.usage).length).toBe(1);
  });

  it("records stdin writes from the steering ops", async () => {
    const recording = loadRecording("pause-now");
    const run = await replay(recording, {
      beforeRead: (child, chunks) => {
        if (chunks !== 5) return;
        for (const op of encode({ kind: "pause" })) {
          if ("write" in op) child.stdin?.write(op.write);
        }
        child.stdin?.end();
      },
    });
    const child = run.fake.processes[0];
    expect(child?.stdinWrites.length).toBe(1);
    expect(JSON.parse(child?.stdinWrites[0] ?? "{}")).toMatchObject({
      type: "user",
      priority: "now",
    });
    expect(child?.stdinClosed).toBe(true);
    expect(run.fake.calls[0]?.stdin).toBe("pipe");
  });

  it("stall: a 30-minute gap replays at once and fires a 20-minute timer on the manual clock", async () => {
    const recording = loadRecording("stall");
    const clock = new ManualClock();
    const start = clock.now();
    let stalledAt = -1;
    clock.setTimeout(
      () => {
        stalledAt = clock.now() - start;
      },
      20 * 60 * 1000,
    );
    const started = performance.now();
    const run = await replay(recording, { clock });
    expect(run.elapsed).toBeGreaterThan(30 * 60 * 1000);
    expect(stalledAt).toBe(20 * 60 * 1000);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("resume: one spawn per recorded process", async () => {
    const run = await replay(loadRecording("resume"));
    expect(run.fake.calls.length).toBe(2);
    expect(run.events.filter((event) => event.t === "started").length).toBe(2);
  });
});
