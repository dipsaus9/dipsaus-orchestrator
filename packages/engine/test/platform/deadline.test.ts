// The deadline of every `gh` call (DIPO-314): a `gh` that never exits gets SIGTERM with its
// process group after 60 s on the engine clock and SIGKILL after the grace, and the call throws
// `CodeHostError` with code `timedOut` naming the command and the deadline. `withDeadline`,
// `terminateChild` and the tracked calls the daemon's stop ends, on a manual clock.

import { describe, expect, it } from "bun:test";

import type { ChildProcess, SpawnOptions } from "@dipsaus-orchestrator/contract";
import { groupRunning, ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  CALL_DEADLINE_MS,
  EngineCalls,
  KILL_GRACE_MS,
  killChildGroup,
  terminateChild,
  timedOutText,
  withDeadline,
} from "../../src/platform/deadline";
import { systemClock } from "../../src/platform/clock";
import { CodeHostError, GhHost, MIN_GH_VERSION } from "../../src/platform/host";
import { systemSpawn } from "../../src/platform/process";
import { HangingProcess, hangingSpawn, settle } from "./hanging";

const VERSION = `gh version ${MIN_GH_VERSION} (2024-05-29)\n`;

/** A child that prints `stdout` and exits 0. */
function finished(stdout: string): ChildProcess {
  return {
    pid: 1,
    stdin: null,
    stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
    stderr: new Response("").body as ReadableStream<Uint8Array>,
    exited: Promise.resolve({ code: 0, signal: null }),
    kill: () => {},
  };
}

/** `gh --version` answers; every other call hangs. */
function hangingGh() {
  return hangingSpawn((options: SpawnOptions) =>
    options.cmd[1] === "--version" ? finished(VERSION) : null,
  );
}

describe("withDeadline", () => {
  it("sends SIGTERM at the deadline, SIGKILL after the grace to a child that ignores it, then rejects", async () => {
    const clock = new ManualClock();
    const child = new HangingProcess({ cmd: ["x"] }, 4100);
    let settled = false;
    const waited = withDeadline(child, new Promise<string>(() => {}), {
      clock,
      deadlineMs: 1_000,
      timedOut: () => new Error("late"),
    })
      .catch((error: unknown) => (error as Error).message)
      .finally(() => (settled = true));
    clock.advance(999);
    expect(child.groupSignals).toEqual([]);
    clock.advance(1);
    await settle();
    expect(child.groupSignals).toEqual(["SIGTERM"]);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);
    clock.advance(KILL_GRACE_MS - 1);
    await settle();
    expect(child.signals).toEqual(["SIGTERM"]);
    clock.advance(1);
    expect(await waited).toBe("late");
    expect(child.groupSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("rejects as soon as a child exits on its SIGTERM, with no SIGKILL, whatever it printed", async () => {
    const clock = new ManualClock();
    const child = new HangingProcess({ cmd: ["x"] }, 4102, "SIGTERM");
    const waited = withDeadline(
      child,
      child.exited.then(() => "partial output"),
      { clock, deadlineMs: 1_000, timedOut: () => new Error("late") },
    ).catch((error: unknown) => (error as Error).message);
    clock.advance(1_000);
    expect(await waited).toBe("late");
    clock.advance(KILL_GRACE_MS);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("returns the work's result and clears its timer when the work wins", async () => {
    const clock = new ManualClock();
    const child = new HangingProcess({ cmd: ["x"] }, 4101);
    const result = await withDeadline(child, Promise.resolve("done"), {
      clock,
      deadlineMs: 1_000,
      timedOut: () => new Error("late"),
    });
    expect(result).toBe("done");
    expect(clock.pendingTimers).toBe(0);
    expect(child.signals).toEqual([]);
  });

  it("kills the child alone when it leads no group of its own", () => {
    const signals: string[] = [];
    killChildGroup({ ...finished(""), kill: (signal) => signals.push(signal ?? "") });
    expect(signals).toEqual(["SIGKILL"]);
  });

  it("names the command and the deadline", () => {
    expect(timedOutText(["gh", "pr", "view", "7"], 60_000)).toBe(
      "`gh pr view 7` did not finish within its deadline of 60 s; dipo stopped it and its process group",
    );
  });
});

describe("the deadline of a gh call", () => {
  it("kills a gh that never exits after 60 s and throws CodeHostError timedOut", async () => {
    const clock = new ManualClock();
    const hang = hangingGh();
    const gh = new GhHost({ spawn: hang.spawn, env: {}, clock });
    let settled = false;
    const view = gh
      .viewPr("o/r", 7)
      .catch((error: unknown) => error)
      .finally(() => (settled = true));
    await settle();
    expect(hang.calls.every((call) => call.detached === true)).toBe(true);
    expect(hang.children).toHaveLength(1);
    clock.advance(CALL_DEADLINE_MS - 1);
    await settle();
    expect(settled).toBe(false);

    clock.advance(1 + KILL_GRACE_MS);
    const error = (await view) as CodeHostError;
    expect(error).toBeInstanceOf(CodeHostError);
    expect(error.code).toBe("timedOut");
    expect(error.message).toContain("`gh pr view 7 --repo o/r");
    expect(error.message).toContain("did not finish within its deadline of 60 s");
    expect(hang.children[0]?.groupSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("gives the version check the same deadline", async () => {
    const clock = new ManualClock();
    const hang = hangingSpawn();
    const gh = new GhHost({ spawn: hang.spawn, env: {}, clock, deadlineMs: 2_000 });
    const checked = gh.checkVersion().catch((error: unknown) => error);
    await settle();
    clock.advance(2_000 + KILL_GRACE_MS);
    const error = (await checked) as CodeHostError;
    expect(error.code).toBe("timedOut");
    expect(error.message).toBe(
      "`gh --version` did not finish within its deadline of 2 s; dipo stopped it and its process group.",
    );
  });

  it("gives a call with stdin the same deadline", async () => {
    const clock = new ManualClock();
    const hang = hangingGh();
    const gh = new GhHost({ spawn: hang.spawn, env: {}, clock });
    const comment = gh.commentPr("o/r", 7, "hello").catch((error: unknown) => error);
    await settle();
    expect(hang.calls.at(-1)?.stdin).toBe("pipe");
    clock.advance(CALL_DEADLINE_MS + KILL_GRACE_MS);
    expect(((await comment) as CodeHostError).code).toBe("timedOut");
  });
});

describe("terminateChild", () => {
  it("resolves at the child's exit and sends no SIGKILL to a child that ends on SIGTERM", async () => {
    const clock = new ManualClock();
    const child = new HangingProcess({ cmd: ["x"] }, 4103, "SIGTERM");
    await terminateChild(child, clock);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("the calls the daemon's stop ends", () => {
  it("tracks calls only once started, forgets those that exit, and ends the rest at stop", async () => {
    const clock = new ManualClock();
    const calls = new EngineCalls();
    calls.track(new HangingProcess({ cmd: ["before"] }, 4200));
    expect(calls.size).toBe(0);

    calls.start();
    const stuck = new HangingProcess({ cmd: ["stuck"] }, 4201);
    const polite = new HangingProcess({ cmd: ["polite"] }, 4202, "SIGTERM");
    const done = new HangingProcess({ cmd: ["done"] }, 4203, "SIGINT");
    for (const child of [stuck, polite, done]) calls.track(child);
    done.kill("SIGINT");
    await settle();
    expect(calls.size).toBe(2);

    const stopped = calls.stop(clock);
    await settle();
    expect(stuck.groupSignals).toEqual(["SIGTERM"]);
    expect(polite.signals).toEqual(["SIGTERM"]);
    clock.advance(KILL_GRACE_MS);
    expect(await stopped).toBe(2);
    expect(stuck.groupSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(polite.signals).toEqual(["SIGTERM"]);
    expect(calls.size).toBe(0);
    // Stopped: nothing is tracked any more.
    calls.track(new HangingProcess({ cmd: ["after"] }, 4204));
    expect(calls.size).toBe(0);
  });
});

/**
 * True once no process of the group `pgid` runs, polled on the system clock for `ms`. A zombie
 * counts as gone: in a box made before DIPO-378 PID 1 reaps no orphan (testkit `groupRunning`,
 * DIPO-372).
 */
async function groupGone(pgid: number, ms: number): Promise<boolean> {
  const until = systemClock.now() + ms;
  for (;;) {
    if (!groupRunning(pgid)) return true;
    if (systemClock.now() >= until) return false;
    await Bun.sleep(20);
  }
}

describe("the daemon's stop on a real process group", () => {
  it("ends a detached child that ignores SIGTERM, and its group, with SIGKILL after the grace", async () => {
    const calls = new EngineCalls();
    calls.start();
    // A shell that ignores SIGTERM, with a child of its own in its group.
    const child = systemSpawn({
      cmd: ["sh", "-c", "trap '' TERM; sleep 30 & wait"],
      detached: true,
    });
    calls.track(child);
    await Bun.sleep(50);
    expect(await calls.stop(systemClock, 100)).toBe(1);
    const exit = await child.exited;
    expect(exit.signal).toBe("SIGKILL");
    // Nothing of the group runs once its members are killed: Linux may still list the group right
    // after the leader's exit, so wait up to 2 s for it to go.
    expect(await groupGone(child.pid, 2_000)).toBe(true);
  });
});
