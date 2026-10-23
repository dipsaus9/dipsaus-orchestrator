// The Backlog CLI's deadline (DIPO-314): a CLI that never exits gets SIGTERM with its process
// group after 60 s on the engine clock and SIGKILL after the grace, the call fails with a coded `timedOut` error naming the command
// and the deadline, and the office git queue item that waited on it ends, so the next item runs.

import { describe, expect, it } from "bun:test";

import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  BacklogCommandError,
  BacklogTimedOutError,
  isBacklogTimedOut,
  runBacklog,
} from "../../src/backlog/runner";
import { GitQueue } from "../../src/git/queue";
import { CALL_DEADLINE_MS, KILL_GRACE_MS } from "../../src/platform/deadline";
import { hangingSpawn, settle } from "../platform/hanging";

/** `--version` reads no project, so the call runs in a folder without one. */
const VERSION = ["--version"];

describe("the Backlog CLI's deadline", () => {
  it("kills a CLI that never exits, and its group, after 60 s on the engine clock", async () => {
    const clock = new ManualClock();
    const hang = hangingSpawn();
    let settled = false;
    const call = runBacklog({ spawn: hang.spawn, clock, env: {} }, "/nowhere", VERSION)
      .catch((error: unknown) => error)
      .finally(() => (settled = true));
    await settle();
    expect(CALL_DEADLINE_MS).toBe(60_000);
    expect(hang.calls[0]?.detached).toBe(true);
    clock.advance(CALL_DEADLINE_MS - 1);
    await settle();
    expect(settled).toBe(false);
    expect(hang.children[0]?.signals).toEqual([]);

    clock.advance(1);
    await settle();
    // SIGTERM first, so the CLI can end cleanly; the call waits for the grace.
    expect(hang.children[0]?.groupSignals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);
    clock.advance(KILL_GRACE_MS);
    const error = await call;
    expect(error).toBeInstanceOf(BacklogTimedOutError);
    expect(isBacklogTimedOut(error)).toBe(true);
    // A failed CLI call, so every caller that handles one handles this one.
    expect(error).toBeInstanceOf(BacklogCommandError);
    const timedOut = error as BacklogTimedOutError;
    expect(timedOut.code).toBe("timedOut");
    expect(timedOut.deadlineMs).toBe(CALL_DEADLINE_MS);
    expect(timedOut.command).toEqual(["backlog", "--version"]);
    expect(timedOut.message).toBe(
      "`backlog --version` did not finish within its deadline of 60 s; dipo stopped it and its process group",
    );
    expect(hang.children[0]?.groupSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(hang.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("takes the deadline the CLI is given", async () => {
    const clock = new ManualClock();
    const hang = hangingSpawn();
    const call = runBacklog(
      { spawn: hang.spawn, clock, env: {}, deadlineMs: 5_000 },
      "/nowhere",
      VERSION,
    ).catch((error: unknown) => error);
    await settle();
    clock.advance(5_000 + KILL_GRACE_MS);
    const error = (await call) as BacklogTimedOutError;
    expect(error.code).toBe("timedOut");
    expect(error.message).toContain("deadline of 5 s");
  });

  it("clears its deadline when the CLI finishes in time", async () => {
    const clock = new ManualClock();
    const out = await runBacklog(
      {
        spawn: () => ({
          pid: 1,
          stdin: null,
          stdout: new Response("1.53.0\n").body as ReadableStream<Uint8Array>,
          stderr: new Response("").body as ReadableStream<Uint8Array>,
          exited: Promise.resolve({ code: 0, signal: null }),
          kill: () => {},
        }),
        clock,
        env: {},
      },
      "/nowhere",
      VERSION,
    );
    expect(out.stdout).toBe("1.53.0\n");
    expect(clock.pendingTimers).toBe(0);
  });

  it("frees the office git queue item that waited on it, so the next item runs", async () => {
    const clock = new ManualClock();
    const hang = hangingSpawn();
    const queue = new GitQueue();
    const first = queue
      .run(() => runBacklog({ spawn: hang.spawn, clock, env: {} }, "/nowhere", VERSION))
      .catch((error: unknown) => error);
    let ran = false;
    const second = queue.run(async () => {
      ran = true;
      return "next";
    });
    await settle();
    expect(queue.pending).toBe(2);
    expect(ran).toBe(false);

    clock.advance(CALL_DEADLINE_MS + KILL_GRACE_MS);
    expect(await first).toBeInstanceOf(BacklogTimedOutError);
    expect(await second).toBe("next");
    expect(ran).toBe(true);
    expect(queue.pending).toBe(0);
  });
});
