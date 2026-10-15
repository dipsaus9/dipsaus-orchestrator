// Steering ops map to stdin writes, a stdin close and signals (0008 sections 1 and 6), and a
// delayed signal is cancelled once the worker exits, so it can never reach a reused PID
// (DIPO-44 AC #9).

import { describe, expect, it } from "bun:test";

import type { ChildExit, ChildProcess, Signal } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { exitCause } from "../../src/host/main";
import type { OpFrame } from "../../src/host/protocol";
import { hostOpOf, Steering } from "../../src/host/steering";
import { encode } from "../../src/workers/claude-cli/encode";

/** A child that records what the host does to it. */
function recordingChild(stdin = true) {
  const writes: string[] = [];
  const signals: Signal[] = [];
  let ended = false;
  const child: ChildProcess = {
    pid: 4242,
    stdin: stdin
      ? {
          write: (chunk) => {
            if (ended) throw new Error("write after end");
            writes.push(String(chunk));
          },
          end: () => {
            ended = true;
          },
        }
      : null,
    stdout: new ReadableStream(),
    stderr: new ReadableStream(),
    exited: new Promise<ChildExit>(() => {}),
    kill: (signal = "SIGTERM") => {
      signals.push(signal);
    },
  };
  return { child, writes, signals, ended: () => ended };
}

describe("hostOpOf", () => {
  it("maps the steering frames to host ops and leaves status and watch out", () => {
    const frames: OpFrame[] = [
      { kind: "op", id: 1, op: "write", data: "hi\n" },
      { kind: "op", id: 2, op: "signal", signal: "SIGINT" },
      { kind: "op", id: 3, op: "signal", signal: "SIGKILL", afterMs: 30_000 },
      { kind: "op", id: 4, op: "closeStdin" },
      { kind: "op", id: 5, op: "status" },
      { kind: "op", id: 6, op: "watch" },
    ];
    expect(frames.map(hostOpOf)).toEqual([
      { write: "hi\n" },
      { signal: "SIGINT" },
      { signal: "SIGKILL", afterMs: 30_000 },
      { closeStdin: true },
      null,
      null,
    ]);
  });
});

describe("Steering", () => {
  it("turns writes into stdin writes, closeStdin into an end, and signals into kills", () => {
    const clock = new ManualClock();
    const { child, writes, signals, ended } = recordingChild();
    const steering = new Steering(child, clock);
    expect(steering.apply({ write: "one\n" })).toEqual({ ok: true });
    expect(steering.apply({ signal: "SIGINT" })).toEqual({ ok: true });
    expect(steering.apply({ closeStdin: true })).toEqual({ ok: true });
    expect(ended()).toBe(true);
    expect(steering.stdinOpen).toBe(false);
    expect(steering.apply({ write: "two\n" })).toEqual({
      ok: false,
      error: { code: "stdin.closed", message: "Stdin is closed." },
    });
    expect(writes).toEqual(["one\n"]);
    expect(signals).toEqual(["SIGINT"]);
  });

  it("runs the Claude stop op: message, stdin close, SIGTERM after 10 s, SIGKILL after 30 s", () => {
    const clock = new ManualClock();
    const { child, writes, signals, ended } = recordingChild();
    const steering = new Steering(child, clock);
    for (const op of encode({ kind: "stop" })) expect(steering.apply(op).ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(ended()).toBe(true);
    expect(signals).toEqual([]);
    expect(steering.lastSignal).toBeNull();
    expect(steering.pendingSignals).toBe(2);
    clock.advance(10_000);
    expect(signals).toEqual(["SIGTERM"]);
    expect(steering.lastSignal).toBe("SIGTERM");
    clock.advance(20_000);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(steering.lastSignal).toBe("SIGKILL");
    expect(steering.pendingSignals).toBe(0);
  });

  it("cancels delayed signals when the worker exits, so none reaches a reused PID", () => {
    const clock = new ManualClock();
    const { child, signals } = recordingChild();
    const steering = new Steering(child, clock);
    steering.apply({ signal: "SIGTERM", afterMs: 10_000 });
    steering.apply({ signal: "SIGKILL", afterMs: 30_000 });
    clock.advance(5_000);
    expect(steering.workerExited()).toBe(2);
    // An armed signal that never fired was never sent (DIPO-88).
    expect(steering.lastSignal).toBeNull();
    clock.advance(60_000);
    expect(signals).toEqual([]);
    expect(steering.pendingSignals).toBe(0);
    expect(steering.apply({ signal: "SIGKILL" })).toEqual({
      ok: false,
      error: { code: "worker.exited", message: "The worker has exited." },
    });
    expect(signals).toEqual([]);
  });

  it("refuses writes to a worker without stdin and reports failed writes", () => {
    const clock = new ManualClock();
    const none = new Steering(recordingChild(false).child, clock);
    expect(none.apply({ write: "x" }).ok).toBe(false);
    const broken = recordingChild();
    const steering = new Steering(
      {
        ...broken.child,
        stdin: {
          write: () => {
            throw new Error("EPIPE");
          },
          end: () => {},
        },
      },
      clock,
    );
    expect(steering.apply({ write: "x" })).toEqual({
      ok: false,
      error: { code: "stdin.failed", message: "EPIPE" },
    });
  });
});

describe("exitCause (DIPO-88)", () => {
  it("keeps a signal the process reports, whatever the host sent", () => {
    expect(exitCause({ code: null, signal: "SIGTERM" }, "SIGTERM")).toEqual({
      code: null,
      signal: "SIGTERM",
    });
    expect(exitCause({ code: null, signal: "SIGKILL" }, "SIGTERM")).toEqual({
      code: null,
      signal: "SIGKILL",
    });
  });

  it("infers the signal the host sent last when the worker handled it and exited non-zero", () => {
    expect(exitCause({ code: 143, signal: null }, "SIGTERM")).toEqual({
      code: 143,
      signal: "SIGTERM",
      signalInferred: true,
    });
    expect(exitCause({ code: 1, signal: null }, "SIGKILL")).toEqual({
      code: 1,
      signal: "SIGKILL",
      signalInferred: true,
    });
  });

  it("infers nothing for a worker that exits on its own or exits 0", () => {
    expect(exitCause({ code: 0, signal: null }, null)).toEqual({ code: 0, signal: null });
    expect(exitCause({ code: 143, signal: null }, null)).toEqual({ code: 143, signal: null });
    expect(exitCause({ code: 0, signal: null }, "SIGTERM")).toEqual({ code: 0, signal: null });
  });
});
