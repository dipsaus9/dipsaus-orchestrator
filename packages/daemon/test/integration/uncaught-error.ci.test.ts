// CI only (0017 section 1): a real daemon process, started as the `dipo` binary starts it (a
// top-level await that sets the exit code), meets errors no code catches (DIPO-110, DIPO-117). The
// daemon logs each once with its code, drains with the reason "uncaught error" (capped as usual,
// then the socket closes and the database is checkpointed and closed), keeps its crash marker and
// exits 1, so the next start counts a crash and three within 10 minutes start in `safe`. A
// requested stop without such an error still exits 0 and is not counted.
//
// Measured on Bun 1.4.2 (macOS arm64), under a top-level await that sets `process.exitCode`:
// - An unhandled rejection with no listener is reported on stderr (`error: <message>`), the process
//   keeps running, and it exits 1 at its end whatever exit code it set (DIPO-110).
// - A synchronous throw from a timer callback with no listener behaves the same: reported on
//   stderr, the process keeps running, exit 1 at its end.
// - With an `uncaughtException` listener that returns, the timer throw goes only to the listener:
//   no report, the process keeps running, and the exit code it set holds (0 if it set 0).
// - A listener that throws the error again exits the process at once with code 7, without a drain.
// So the daemon's listeners never throw; the drain and the exit 1 are the daemon's own.
//
// State, runtime and temp files stay under the test's temp directory, and every process is stopped
// in a `finally`.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  assertTestRuntimeDir,
  daemonTestEnv,
  withDaemonTempDir,
} from "@dipsaus-orchestrator/testkit";

const FIXTURE = resolve(import.meta.dir, "fixtures/uncaught-daemon.ts");
const TIMEOUT_MS = 30_000;
const REJECTION = "an unhandled rejection reached the daemon";
const EXCEPTION = "an uncaught exception reached the daemon";
const CRASH_EXIT = "exiting 1 after an uncaught error; the next start counts a crash";

type Line = {
  msg: string;
  level: string;
  to?: string;
  reason?: string;
  childPid?: number;
  removed?: boolean;
  errorCode?: string;
  error?: { message?: string };
};

type CrashFile = { running: { pid: number } | null; crashes: number[] };

function readLog(dir: string): Line[] {
  const path = join(dir, "state", "logs", "daemon.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Line);
}

function readCrashFile(dir: string): CrashFile {
  return JSON.parse(readFileSync(join(dir, "state", "crashes.json"), "utf8")) as CrashFile;
}

function start(dir: string, args: readonly string[]): Bun.Subprocess<"ignore", "ignore", "pipe"> {
  return Bun.spawn({
    cmd: [process.execPath, FIXTURE, ...args],
    env: daemonTestEnv(dir),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
}

/** Waits until a log line written after `from` lines matches. */
async function waitForLog(
  dir: string,
  daemon: Bun.Subprocess,
  what: string,
  match: (line: Line) => boolean,
  from = 0,
): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    // A daemon that chose a runtime directory outside `dir` fails the test (DIPO-109).
    assertTestRuntimeDir(dir);
    if (readLog(dir).slice(from).some(match)) return;
    if (daemon.exitCode !== null) throw new Error(`daemon exited with ${daemon.exitCode}`);
    await Bun.sleep(50);
  }
  throw new Error(`the daemon logged no ${what} within 10 s`);
}

const reachedState = (state: string) => (line: Line) =>
  line.msg === "daemon state" && line.to === state;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanup(daemon: Bun.Subprocess, children: number[] = []): Promise<void> {
  if (daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill("SIGKILL");
    await daemon.exited;
  }
  for (const pid of children) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** The ordered close-down after a drain: socket removed, database closed, lock released. */
function expectClosedDown(dir: string, log: Line[]): void {
  const messages = log.map((line) => line.msg);
  expect(log.find((line) => line.msg === "socket closed")?.removed).toBe(true);
  expect(messages.indexOf("socket closed")).toBeLessThan(messages.indexOf("closed state database"));
  expect(messages.indexOf("closed state database")).toBeLessThan(messages.indexOf("lock released"));
  expect(messages.at(-1)).toBe("daemon stopped");
  expect(existsSync(join(dir, "run", "dipo.sock"))).toBe(false);
  expect(existsSync(join(dir, "state", "dipo.pid"))).toBe(false);
  expect(existsSync(join(dir, "state", "dipo.db-wal"))).toBe(false);
  expect(existsSync(join(dir, "state", "dipo.db-shm"))).toBe(false);
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("an error no code catches in a real daemon process", () => {
    it(
      "an unhandled rejection is logged once, drains under the cap with its own reason, closes down and exits 1 with the crash marker kept; a second one starts no second drain",
      () =>
        withDaemonTempDir(async (dir) => {
          // The child outlives the 1 s cap, so the drain lasts until the cap and the second
          // rejection, 300 ms after the first, arrives during it.
          const daemon = start(dir, ["reject", "sleep 30", "1000"]);
          let child = 0;
          try {
            await waitForLog(dir, daemon, "rejection", (line) => line.msg === REJECTION);
            child = readLog(dir).find((line) => line.msg === "test child started")?.childPid ?? 0;
            expect(await daemon.exited).toBe(1);
            const log = readLog(dir);
            const messages = log.map((line) => line.msg);

            const failures = log.filter((line) => line.msg === REJECTION);
            expect(failures.map((line) => line.error?.message)).toEqual([
              "disk I/O error",
              "second disk I/O error",
            ]);
            for (const line of failures) {
              expect(line).toMatchObject({ level: "error", errorCode: "SQLITE_IOERR" });
            }
            // One drain, with its own reason, even after the second rejection.
            const draining = log.filter(reachedState("draining"));
            expect(draining.map((line) => line.reason)).toEqual(["uncaught error"]);
            expect(messages.filter((m) => m === "draining")).toHaveLength(1);
            expect(messages).toContain("the drain reached its cap; exiting anyway");
            expect(messages.indexOf("the drain reached its cap; exiting anyway")).toBeLessThan(
              messages.indexOf("socket closed"),
            );
            expect(log.find((line) => line.msg === CRASH_EXIT)?.reason).toBe("uncaught error");
            expectClosedDown(dir, log);
            if (child !== 0) expect(alive(child)).toBe(false);

            // The crash marker stays: the next start counts this exit as a crash.
            expect(readCrashFile(dir).running).toMatchObject({ pid: daemon.pid });
            // Logged once by the daemon; Bun does not report it again.
            const stderr = await new Response(daemon.stderr).text();
            expect(stderr).not.toMatch(/^error: /m);
          } finally {
            await cleanup(daemon, child === 0 ? [] : [child]);
          }
        }),
      TIMEOUT_MS,
    );

    it(
      "a synchronous throw from a timer is logged once, drains, closes down and exits 1 with the crash marker kept",
      () =>
        withDaemonTempDir(async (dir) => {
          const daemon = start(dir, ["timer-throw"]);
          try {
            expect(await daemon.exited).toBe(1);
            const log = readLog(dir);
            const messages = log.map((line) => line.msg);
            const failures = log.filter((line) => line.msg === EXCEPTION);
            expect(failures).toHaveLength(1);
            expect(failures[0]).toMatchObject({
              level: "error",
              errorCode: "ENOSPC",
              error: { message: "no space left on device" },
            });
            expect(log.filter(reachedState("draining")).map((line) => line.reason)).toEqual([
              "uncaught error",
            ]);
            expect(messages).toContain("drained");
            expect(messages).toContain(CRASH_EXIT);
            expectClosedDown(dir, log);
            expect(readCrashFile(dir).running).toMatchObject({ pid: daemon.pid });
            const stderr = await new Response(daemon.stderr).text();
            expect(stderr).not.toMatch(/^error: /m);
          } finally {
            await cleanup(daemon);
          }
        }),
      TIMEOUT_MS,
    );

    it(
      "an uncaught error during a SIGTERM drain keeps the drain's reason, exits 1 and keeps the crash marker",
      () =>
        withDaemonTempDir(async (dir) => {
          // The child keeps the SIGTERM drain open past the throw 100 ms after the signal.
          const daemon = start(dir, ["stop-throw", "sleep 3", "20000"]);
          let child = 0;
          try {
            await waitForLog(dir, daemon, "running state", reachedState("running"));
            child = readLog(dir).find((line) => line.msg === "test child started")?.childPid ?? 0;
            daemon.kill("SIGTERM");
            expect(await daemon.exited).toBe(1);
            const log = readLog(dir);
            const messages = log.map((line) => line.msg);
            expect(log.filter(reachedState("draining")).map((line) => line.reason)).toEqual([
              "SIGTERM",
            ]);
            const failure = log.find((line) => line.msg === EXCEPTION);
            expect(failure).toMatchObject({ errorCode: "EPIPE" });
            expect(messages.indexOf(EXCEPTION)).toBeLessThan(messages.indexOf("drained"));
            expect(log.find((line) => line.msg === CRASH_EXIT)?.reason).toBe("SIGTERM");
            expectClosedDown(dir, log);
            expect(readCrashFile(dir).running).toMatchObject({ pid: daemon.pid });
          } finally {
            await cleanup(daemon, child === 0 ? [] : [child]);
          }
        }),
      TIMEOUT_MS,
    );

    it(
      "each such exit counts as a crash at the next start, three start in safe, and a clean stop exits 0 and is not counted",
      () =>
        withDaemonTempDir(async (dir) => {
          for (let crash = 0; crash < 3; crash++) {
            const daemon = start(dir, ["timer-throw"]);
            try {
              expect(await daemon.exited).toBe(1);
              expect(readCrashFile(dir).crashes).toHaveLength(crash);
            } finally {
              await cleanup(daemon);
            }
          }
          const before = readLog(dir).length;
          const daemon = start(dir, ["none"]);
          try {
            await waitForLog(dir, daemon, "safe state", reachedState("safe"), before);
            const transition = readLog(dir).slice(before).find(reachedState("safe"));
            expect(transition?.reason).toBe("crash loop");
            expect(readCrashFile(dir)).toMatchObject({
              running: { pid: daemon.pid },
              crashes: expect.any(Array),
            });
            expect(readCrashFile(dir).crashes).toHaveLength(3);
            daemon.kill("SIGTERM");
            expect(await daemon.exited).toBe(0);
            const log = readLog(dir).slice(before);
            expect(log.map((line) => line.msg)).not.toContain(CRASH_EXIT);
            // A clean stop clears the marker: the next start records no crash for it.
            expect(readCrashFile(dir).running).toBeNull();
            expect(readCrashFile(dir).crashes).toHaveLength(3);
          } finally {
            await cleanup(daemon);
          }
        }),
      60_000,
    );
  });
}
