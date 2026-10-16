// An error no code caught (DIPO-117, 0006 decision 7) in a daemon run in-process on the manual
// clock, with a fake source standing in for `process`: the daemon drains with the reason "uncaught
// error", or keeps the reason of a drain already requested (`daemon.stop`), and exits 1 with its
// crash marker kept, so the next start counts a crash. A child the daemon started holds each drain
// open until the test ends it. The real process is in uncaught-error.ci.test.ts.

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isolatedDaemonEnv, ManualClock, withDaemonTempDir } from "@dipsaus-orchestrator/testkit";

import { CRASH_FILE, CrashCounter } from "../../src/crash-counter";
import { runForeground } from "../../src/foreground";
import { TestClient } from "../support/client";

type Message = { msg: string; to?: string; reason?: string; errorCode?: string };

/** Runs the daemon in this process with a recovery step that starts a long child. */
function startInProcess(dir: string) {
  const clock = new ManualClock();
  const uncaught = new EventEmitter();
  const lines: string[] = [];
  let child = 0;
  const exited = runForeground(
    [],
    {
      writeLine: () => {},
      writeError: (line) => lines.push(line),
      env: isolatedDaemonEnv(dir),
      execArgv: [],
      version: "test",
      clock,
      onShutdownSignal: () => () => {},
    },
    {
      uncaughtErrors: uncaught,
      recoverySteps: [
        {
          name: "drain holder",
          run: async (context) => {
            child = context.children.spawn(["/bin/sh", "-c", "sleep 30"]).pid;
          },
        },
      ],
    },
  );
  const messages = () =>
    lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Message];
      } catch {
        return [];
      }
    });
  const waitFor = async (predicate: () => boolean, what: string) => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return;
      await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for ${what}; log:\n${lines.join("\n")}`);
  };
  const endChild = () => {
    if (child === 0) return;
    try {
      process.kill(-child, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  const reached = (state: string) =>
    messages().some((m) => m.msg === "daemon state" && m.to === state);
  return { exited, messages, waitFor, uncaught, endChild, reached };
}

function readMarker(dir: string): { pid: number } | null {
  const file = JSON.parse(readFileSync(join(dir, "state", CRASH_FILE), "utf8")) as {
    running: { pid: number } | null;
  };
  return file.running;
}

const drainReasons = (messages: Message[]) =>
  messages.filter((m) => m.msg === "daemon state" && m.to === "draining").map((m) => m.reason);

describe("an error no code caught in the daemon", () => {
  it(
    "drains with its own reason once, exits 1 and keeps the marker, so the next start counts a crash",
    () =>
      withDaemonTempDir(async (dir) => {
        const daemon = startInProcess(dir);
        try {
          await daemon.waitFor(() => daemon.reached("running"), "running");
          const error = Object.assign(new Error("no space left"), { code: "ENOSPC" });
          daemon.uncaught.emit("uncaughtException", error);
          await daemon.waitFor(() => daemon.reached("draining"), "draining");
          // A second error during the drain starts no second drain.
          daemon.uncaught.emit("unhandledRejection", new Error("again"));
          daemon.endChild();
          expect(await daemon.exited).toBe(1);
        } finally {
          daemon.endChild();
        }
        const messages = daemon.messages();
        expect(drainReasons(messages)).toEqual(["uncaught error"]);
        expect(messages.filter((m) => m.msg === "draining")).toHaveLength(1);
        expect(
          messages.filter((m) => m.msg === "an uncaught exception reached the daemon"),
        ).toEqual([expect.objectContaining({ errorCode: "ENOSPC" })]);
        expect(
          messages.filter((m) => m.msg === "an unhandled rejection reached the daemon"),
        ).toHaveLength(1);
        expect(messages.map((m) => m.msg)).toContain("closed state database");
        expect(readMarker(dir)).toMatchObject({ pid: process.pid });

        // The next daemon is another process: the marker left behind is one crash.
        const next = CrashCounter.open(
          join(dir, "state"),
          { pid: process.pid, startTimeMs: 2 },
          new ManualClock(),
        );
        expect(next.previousCrashed).toBe(true);
        expect(next.counter.recentCrashes).toBe(1);
      }),
    20_000,
  );

  it(
    "during a drain daemon.stop requested keeps that reason, exits 1 and keeps the marker",
    () =>
      withDaemonTempDir(async (dir) => {
        const daemon = startInProcess(dir);
        try {
          await daemon.waitFor(() => daemon.reached("running"), "running");
          const client = await TestClient.connect(join(dir, "run", "dipo.sock"));
          expect((await client.hello()).ok).toBe(true);
          const reply = await client.command("daemon.stop", { stopWorkers: false });
          expect(reply).toMatchObject({ ok: true, result: { state: "draining" } });
          // The child holds the drain open: the daemon has not closed down yet.
          daemon.uncaught.emit("unhandledRejection", new Error("disk I/O error"));
          daemon.endChild();
          expect((await client.closed).code).toBe(1001);
          expect(await daemon.exited).toBe(1);
        } finally {
          daemon.endChild();
        }
        const messages = daemon.messages();
        expect(drainReasons(messages)).toEqual(["daemon.stop"]);
        expect(
          messages.find(
            (m) => m.msg === "exiting 1 after an uncaught error; the next start counts a crash",
          )?.reason,
        ).toBe("daemon.stop");
        expect(readMarker(dir)).toMatchObject({ pid: process.pid });
      }),
    20_000,
  );
});
