// An error no code caught (DIPO-117, 0005) in a daemon run in-process on the manual clock, with a
// fake source standing in for `process`: the daemon drains with the reason "uncaught error", or
// keeps the reason of a drain already requested (`daemon.stop`), and exits 1. An error before the
// lock is taken still counts: the daemon takes the lock, drains at once from `starting` and exits 1. A start that finds
// another daemon running exits 0 as before, and 1 only after an error of its own. A child the daemon
// started holds each drain open until the test ends it. The real process is in
// uncaught-error.ci.test.ts. Every daemon is stopped in a `finally`.

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  assertTestRuntimeDir,
  daemonTestEnv,
  isolatedDaemonEnv,
  ManualClock,
  withDaemonTempDir,
} from "@dipsaus-orchestrator/testkit";

import type { Clock } from "@dipsaus-orchestrator/contract";
import { systemClock } from "@dipsaus-orchestrator/engine/platform";

import { runForeground } from "../../src/foreground";
import { TestClient } from "../support/client";

// The running daemon is the real binary's entry: the lock only counts a `dipo daemon` command live.
const MAIN = resolve(import.meta.dir, "../../../cli/src/main.ts");
const CRASH_EXIT = "exiting 1 after an uncaught error";

type Message = { msg: string; to?: string; reason?: string; errorCode?: string };

/**
 * Runs the daemon in this process with a recovery step that starts a long child. With `raise`,
 * an uncaught exception arrives at once, before the daemon reads its configuration or the lock.
 * A start that meets a running daemon asks it over the socket with timeouts on `clock`, so those
 * tests pass the real clock.
 */
function startInProcess(dir: string, raise = false, clock: Clock = new ManualClock()) {
  const uncaught = new EventEmitter();
  const lines: string[] = [];
  const out: string[] = [];
  let child = 0;
  let signal: ((name: string) => void) | null = null;
  let done = false;
  const exited = runForeground(
    [],
    {
      writeLine: (line) => out.push(line),
      writeError: (line) => lines.push(line),
      env: isolatedDaemonEnv(dir),
      execArgv: [],
      version: "test",
      clock,
      onShutdownSignal: (handler) => {
        signal = handler;
        return () => {
          signal = null;
        };
      },
      uncaughtErrors: uncaught,
    },
    {
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
  void exited.then(() => (done = true));
  // runForeground listens before its first await, so this error comes before the lock.
  if (raise) uncaught.emit("uncaughtException", new Error("thrown at start"));
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
  /** Ends the child and stops the daemon if a test left it running. */
  const stop = async () => {
    endChild();
    if (!done) signal?.("SIGTERM");
    await exited;
  };
  return { exited, messages, out, waitFor, uncaught, endChild, reached, stop };
}

const transitions = (messages: Message[]) =>
  messages.filter((m) => m.msg === "daemon state" && m.to !== undefined).map((m) => m.to);

const drainReasons = (messages: Message[]) =>
  messages.filter((m) => m.msg === "daemon state" && m.to === "draining").map((m) => m.reason);

describe("an error no code caught in the daemon", () => {
  it(
    "drains with its own reason once and exits 1",
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
          await daemon.stop();
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
        expect(existsSync(join(dir, "state", "crashes.json"))).toBe(false);
      }),
    20_000,
  );

  it(
    "during a drain daemon.stop requested keeps that reason and exits 1",
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
          await daemon.stop();
        }
        const messages = daemon.messages();
        expect(drainReasons(messages)).toEqual(["daemon.stop"]);
        expect(messages.find((m) => m.msg === CRASH_EXIT)?.reason).toBe("daemon.stop");
      }),
    20_000,
  );

  it(
    "before the lock is taken, still takes the lock, drains at once from starting and exits 1",
    () =>
      withDaemonTempDir(async (dir) => {
        const daemon = startInProcess(dir, true);
        try {
          expect(await daemon.exited).toBe(1);
        } finally {
          await daemon.stop();
        }
        const messages = daemon.messages();
        // No recovery runs: the state database is never opened and no step starts a child.
        expect(transitions(messages)).toEqual(["starting", "draining"]);
        expect(drainReasons(messages)).toEqual(["uncaught error"]);
        expect(messages.map((m) => m.msg)).not.toContain("opened state database");
        expect(messages.find((m) => m.msg === CRASH_EXIT)?.reason).toBe("uncaught error");
        expect(existsSync(join(dir, "state", "dipo.pid"))).toBe(false);
        expect(existsSync(join(dir, "run", "dipo.sock"))).toBe(false);
      }),
    20_000,
  );

  it(
    "a start that finds another daemon running exits 0 as before, and 1 only after an error of its own",
    () =>
      withDaemonTempDir(async (dir) => {
        const running = Bun.spawn({
          cmd: [process.execPath, MAIN, "daemon", "--foreground"],
          env: daemonTestEnv(dir),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        try {
          const log = join(dir, "state", "logs", "daemon.log");
          let up = false;
          for (let i = 0; i < 400 && !up; i++) {
            // A daemon that chose a runtime directory outside `dir` fails the test (DIPO-109).
            assertTestRuntimeDir(dir);
            if (running.exitCode !== null)
              throw new Error(`daemon exited with ${running.exitCode}`);
            up = existsSync(log) && readFileSync(log, "utf8").includes('"to":"running"');
            if (!up) await Bun.sleep(25);
          }
          if (!up) throw new Error("the running daemon did not reach running within 10 s");

          const quiet = startInProcess(dir, false, systemClock);
          try {
            expect(await quiet.exited).toBe(0);
          } finally {
            await quiet.stop();
          }
          expect(quiet.out.join("\n")).toContain("dipo daemon is already running");

          const failing = startInProcess(dir, true, systemClock);
          try {
            expect(await failing.exited).toBe(1);
          } finally {
            await failing.stop();
          }
          expect(failing.out.join("\n")).toContain("dipo daemon is already running");

          running.kill("SIGTERM");
          expect(await running.exited).toBe(0);
        } finally {
          if (running.exitCode === null && running.signalCode === null) {
            running.kill("SIGKILL");
            await running.exited;
          }
        }
      }),
    20_000,
  );
});
