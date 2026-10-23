// The deadline of every `gh` call (DIPO-314): a `gh` that never exits is killed with its process
// group after 60 s on the engine clock, and the call throws `CodeHostError` with code `timedOut`
// naming the command and the deadline. `withDeadline` itself, on a manual clock.

import { describe, expect, it } from "bun:test";

import type { ChildProcess, SpawnOptions } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  CALL_DEADLINE_MS,
  killChildGroup,
  timedOutText,
  withDeadline,
} from "../../src/platform/deadline";
import { CodeHostError, GhHost, MIN_GH_VERSION } from "../../src/platform/host";
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
  it("rejects at the deadline, kills the group and does not wait for the work", async () => {
    const clock = new ManualClock();
    const child = new HangingProcess({ cmd: ["x"] }, 4100);
    const waited = withDeadline(child, new Promise<string>(() => {}), {
      clock,
      deadlineMs: 1_000,
      timedOut: () => new Error("late"),
    }).catch((error: unknown) => (error as Error).message);
    clock.advance(999);
    expect(child.groupSignals).toEqual([]);
    clock.advance(1);
    expect(await waited).toBe("late");
    expect(child.groupSignals).toEqual(["SIGKILL"]);
    expect(child.signals).toEqual(["SIGKILL"]);
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
      "`gh pr view 7` did not finish within its deadline of 60 s; dipo killed it and its process group",
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

    clock.advance(1);
    const error = (await view) as CodeHostError;
    expect(error).toBeInstanceOf(CodeHostError);
    expect(error.code).toBe("timedOut");
    expect(error.message).toContain("`gh pr view 7 --repo o/r");
    expect(error.message).toContain("did not finish within its deadline of 60 s");
    expect(hang.children[0]?.groupSignals).toEqual(["SIGKILL"]);
  });

  it("gives the version check the same deadline", async () => {
    const clock = new ManualClock();
    const hang = hangingSpawn();
    const gh = new GhHost({ spawn: hang.spawn, env: {}, clock, deadlineMs: 2_000 });
    const checked = gh.checkVersion().catch((error: unknown) => error);
    await settle();
    clock.advance(2_000);
    const error = (await checked) as CodeHostError;
    expect(error.code).toBe("timedOut");
    expect(error.message).toBe(
      "`gh --version` did not finish within its deadline of 2 s; dipo killed it and its process group.",
    );
  });

  it("gives a call with stdin the same deadline", async () => {
    const clock = new ManualClock();
    const hang = hangingGh();
    const gh = new GhHost({ spawn: hang.spawn, env: {}, clock });
    const comment = gh.commentPr("o/r", 7, "hello").catch((error: unknown) => error);
    await settle();
    expect(hang.calls.at(-1)?.stdin).toBe("pipe");
    clock.advance(CALL_DEADLINE_MS);
    expect(((await comment) as CodeHostError).code).toBe("timedOut");
  });
});
