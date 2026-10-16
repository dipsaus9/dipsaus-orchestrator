// The crash counter (DIPO-68, 0006 decision 7) on the manual clock with real files under DIPO_TMP:
// three recorded crashes within 10 minutes start the daemon in `safe` with reason "crash loop",
// and 10 stable minutes reset the counter. The daemon runs in-process with an injected clock and
// shutdown signal, so no real signal or timer is involved.

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  isolatedDaemonEnv,
  MANUAL_CLOCK_START,
  ManualClock,
  withDaemonTempDir,
  withTempDir,
} from "@dipsaus-orchestrator/testkit";

import { CRASH_FILE, CRASH_WINDOW_MS, CrashCounter, STABLE_RUN_MS } from "../../src/crash-counter";
import { runDaemon } from "../../src/index";

const MINUTE = 60_000;
const SELF = { pid: process.pid, startTimeMs: 1_700_000_000_000 };
const DEAD = { pid: 999_999, startTimeMs: 1 };

type CrashFile = { running: { pid: number } | null; crashes: number[] };

function readCrashFile(stateDir: string): CrashFile {
  return JSON.parse(readFileSync(join(stateDir, CRASH_FILE), "utf8")) as CrashFile;
}

function seed(stateDir: string, crashes: number[], running: typeof DEAD | null): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateDir, CRASH_FILE),
    `${JSON.stringify({ version: 1, running, crashes })}\n`,
  );
}

describe("CrashCounter", () => {
  it("records a crash when the previous daemon left its marker, and none after a clean exit", () =>
    withTempDir((dir) => {
      const clock = new ManualClock();
      const first = CrashCounter.open(dir, DEAD, clock);
      expect(first.previousCrashed).toBe(false);
      expect(first.counter.recentCrashes).toBe(0);

      // DEAD never cleared its marker: the next start counts one crash.
      clock.advance(MINUTE);
      const second = CrashCounter.open(dir, SELF, clock);
      expect(second.previousCrashed).toBe(true);
      expect(second.counter.recentCrashes).toBe(1);
      expect(readCrashFile(dir)).toMatchObject({ running: { pid: SELF.pid } });

      second.counter.cleanExit();
      expect(readCrashFile(dir).running).toBeNull();
      const third = CrashCounter.open(dir, DEAD, clock);
      expect(third.previousCrashed).toBe(false);
      expect(third.counter.recentCrashes).toBe(1);
    }));

  it("reports a crash loop at three crashes within 10 minutes, not at three spread wider", () =>
    withTempDir((dir) => {
      const clock = new ManualClock();
      const now = clock.now();
      seed(dir, [now - 9 * MINUTE, now - 4 * MINUTE], DEAD);
      const loop = CrashCounter.open(dir, SELF, clock).counter;
      expect(loop.recentCrashes).toBe(3);
      expect(loop.crashLoop).toBe(true);

      seed(dir, [now - CRASH_WINDOW_MS, now - 4 * MINUTE], DEAD);
      const spread = CrashCounter.open(dir, SELF, clock).counter;
      expect(spread.recentCrashes).toBe(2);
      expect(spread.crashLoop).toBe(false);
    }));

  it("clears the crashes on reset and keeps its marker", () =>
    withTempDir((dir) => {
      const clock = new ManualClock();
      seed(dir, [clock.now() - MINUTE, clock.now() - 2 * MINUTE], DEAD);
      const { counter } = CrashCounter.open(dir, SELF, clock);
      counter.reset();
      expect(readCrashFile(dir)).toMatchObject({ running: { pid: SELF.pid }, crashes: [] });
    }));

  it("leaves a marker that another daemon wrote meanwhile", () =>
    withTempDir((dir) => {
      const clock = new ManualClock();
      const { counter } = CrashCounter.open(dir, SELF, clock);
      seed(dir, [], DEAD);
      counter.cleanExit();
      expect(readCrashFile(dir).running).toMatchObject({ pid: DEAD.pid });
    }));

  it("starts afresh from a damaged file", () =>
    withTempDir((dir) => {
      writeFileSync(join(dir, CRASH_FILE), "{not json");
      const opened = CrashCounter.open(dir, SELF, new ManualClock());
      expect(opened.damaged).toBe(true);
      expect(opened.counter.recentCrashes).toBe(0);
    }));
});

/** Runs the daemon in this process on the manual clock until `stop` is called. */
function startInProcess(dir: string, clock: ManualClock) {
  const lines: string[] = [];
  let signal: ((name: string) => void) | null = null;
  const exited = runDaemon(["--foreground"], {
    writeLine: () => {},
    writeError: (line) => lines.push(line),
    env: isolatedDaemonEnv(dir),
    execArgv: [],
    version: "test",
    clock,
    onShutdownSignal: (handler) => {
      signal = handler;
      return () => {};
    },
  });
  const messages = () =>
    lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as { msg: string; to?: string; reason?: string }];
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
  return { exited, messages, waitFor, stop: (name = "SIGTERM") => signal?.(name) };
}

describe("dipo daemon --foreground and the crash counter", () => {
  it(
    "starts in safe after three crashes within 10 minutes and resets after 10 stable minutes",
    () =>
      withDaemonTempDir(async (dir) => {
        const clock = new ManualClock();
        const state = join(dir, "state");
        seed(state, [MANUAL_CLOCK_START - 7 * MINUTE, MANUAL_CLOCK_START - 3 * MINUTE], DEAD);
        const daemon = startInProcess(dir, clock);
        try {
          await daemon.waitFor(
            () => daemon.messages().some((m) => m.msg === "daemon state" && m.to === "safe"),
            "safe",
          );
          const transitions = daemon
            .messages()
            .filter((m) => m.msg === "daemon state")
            .map((m) => `${m.to}:${m.reason}`);
          expect(transitions).toEqual([
            "starting:daemon started",
            "recovering:running recovery steps",
            "safe:crash loop",
          ]);
          expect(readCrashFile(state).crashes).toHaveLength(3);

          clock.advance(STABLE_RUN_MS - 1);
          expect(readCrashFile(state).crashes).toHaveLength(3);
          clock.advance(1);
          expect(readCrashFile(state)).toMatchObject({
            running: { pid: process.pid },
            crashes: [],
          });
        } finally {
          daemon.stop();
          expect(await daemon.exited).toBe(0);
        }
        expect(readCrashFile(state).running).toBeNull();
        expect(existsSync(join(state, "dipo.pid"))).toBe(false);
        expect(existsSync(join(dir, "run", "dipo.sock"))).toBe(false);
      }),
    20_000,
  );

  it(
    "counts a failure between the lock and the socket bind as one crash at the next start",
    () =>
      withDaemonTempDir(async (dir) => {
        const clock = new ManualClock();
        const state = join(dir, "state");
        // A non-empty directory where `dipo.sock` goes: removing the leftover socket fails, so the
        // daemon exits 1 in `starting`, after taking the lock and before binding.
        mkdirSync(join(dir, "run", "dipo.sock", "blocker"), { recursive: true, mode: 0o700 });
        chmodSync(join(dir, "run"), 0o700);
        const daemon = startInProcess(dir, clock);
        expect(await daemon.exited).toBe(1);
        expect(daemon.messages().some((m) => m.msg === "listening")).toBe(false);
        expect(existsSync(join(state, "dipo.pid"))).toBe(false);
        expect(readCrashFile(state).running).toMatchObject({ pid: process.pid });

        // The next daemon is another process: the marker left behind is one crash.
        const next = CrashCounter.open(state, { pid: process.pid, startTimeMs: 2 }, clock);
        expect(next.previousCrashed).toBe(true);
        expect(next.counter.recentCrashes).toBe(1);
      }),
    20_000,
  );

  it(
    "starts in running after two crashes, and a clean stop records none",
    () =>
      withDaemonTempDir(async (dir) => {
        const clock = new ManualClock();
        const state = join(dir, "state");
        seed(state, [MANUAL_CLOCK_START - 3 * MINUTE], DEAD);
        const daemon = startInProcess(dir, clock);
        try {
          await daemon.waitFor(
            () => daemon.messages().some((m) => m.msg === "daemon state" && m.to === "running"),
            "running",
          );
          expect(readCrashFile(state).crashes).toHaveLength(2);
        } finally {
          daemon.stop("SIGINT");
          expect(await daemon.exited).toBe(0);
        }
        const drained = daemon
          .messages()
          .find((m) => m.msg === "daemon state" && m.to === "draining");
        expect(drained?.reason).toBe("SIGINT");
        const restarted = CrashCounter.open(state, SELF, clock);
        expect(restarted.previousCrashed).toBe(false);
        expect(restarted.counter.recentCrashes).toBe(2);
      }),
    20_000,
  );
});
