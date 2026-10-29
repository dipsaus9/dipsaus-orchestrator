// `dipo daemon --foreground` in-process with `daemon.autoRestartOnUpgrade: true` (DIPO-70, 0006
// decision 14) on the manual clock: a changed executable drains the daemon and starts the new
// binary; a stop requested before the watcher fires (a signal, `daemon.stop`, a restart) ends the
// daemon without starting anything, and so does an error no code caught during the upgrade drain,
// which exits 1 as a crash (DIPO-117). State, runtime directory and temp files stay under the
// test's temp directory, the spawn of the new binary is recorded, never run, and a fake source
// stands in for `process` for uncaught errors. Each daemon is stopped in a `finally`.

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type DetachedSpawnOptions,
  type ExecutableStamp,
} from "@dipsaus-orchestrator/engine/platform";
import {
  isolatedDaemonEnv,
  ManualClock,
  testStateDir,
  withDaemonTempDir,
} from "@dipsaus-orchestrator/testkit";

import { CRASH_FILE } from "../../src/crash-counter";
import { runForeground } from "../../src/foreground";
import type { DaemonIo } from "../../src/io";
import { UPGRADE_CHECK_MS, UPGRADE_REASON } from "../../src/upgrade";

const OLD: ExecutableStamp = { dev: 1, ino: 10, size: 100, mtimeMs: 1000 };
const NEW: ExecutableStamp = { dev: 1, ino: 11, size: 120, mtimeMs: 2000 };

function setup(
  dir: string,
  onLine: (line: string) => void = () => {},
  uncaught = new EventEmitter(),
) {
  const state = testStateDir(dir);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "config.yaml"), "version: 1\ndaemon:\n  autoRestartOnUpgrade: true\n");
  const clock = new ManualClock();
  let signal: ((name: string) => void) | null = null;
  let stamp = OLD;
  let done = false;
  const spawns: DetachedSpawnOptions[] = [];
  const io: DaemonIo = {
    writeLine: () => {},
    writeError: onLine,
    env: {
      ...isolatedDaemonEnv(dir),
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      BUN_OPTIONS: "--smol",
    },
    execArgv: [],
    version: "0.0.0-test",
    onShutdownSignal: (handler) => {
      signal = handler;
      return () => {
        signal = null;
      };
    },
    clock,
    uncaughtErrors: uncaught,
  };
  const exited = runForeground([], io, {
    readExecutableStamp: () => stamp,
    spawnDetached: (options) => {
      spawns.push(options);
      return { pid: 1 };
    },
  });
  void exited.then(() => (done = true));
  return {
    state,
    clock,
    exited,
    spawns,
    uncaught,
    replace: () => void (stamp = NEW),
    signal: (name: string) => signal?.(name),
    /** Stops the daemon if a test left it running. */
    stop: async () => {
      if (done) return;
      signal?.("SIGTERM");
      await exited;
    },
  };
}

async function untilRunning(state: string, exited: Promise<number>): Promise<void> {
  let done = false;
  void exited.then(() => (done = true));
  const log = join(state, "logs", "daemon.log");
  for (let i = 0; i < 500; i++) {
    if (done) throw new Error("the daemon exited before it was running");
    if (existsSync(log) && readFileSync(log, "utf8").includes('"to":"running"')) return;
    await Bun.sleep(10);
  }
  throw new Error("the daemon did not reach running");
}

describe("auto-restart on upgrade", () => {
  it("drains and starts the new binary once the executable changed", () =>
    withDaemonTempDir(async (dir) => {
      const t = setup(dir);
      try {
        await untilRunning(t.state, t.exited);
        t.replace();
        t.clock.advance(UPGRADE_CHECK_MS);
        expect(await t.exited).toBe(0);
        expect(t.spawns).toHaveLength(1);
        expect(t.spawns[0]?.cmd.slice(-4)).toEqual([
          "daemon",
          "--foreground",
          "--log-level",
          "info",
        ]);
        expect(t.spawns[0]?.env["BUN_OPTIONS"]).toBeUndefined();
        expect(existsSync(join(t.state, "dipo.pid"))).toBe(false);
      } finally {
        await t.stop();
      }
    }));

  it("does not start a new binary when a stop was requested before the watcher fired", () =>
    withDaemonTempDir(async (dir) => {
      const t = setup(dir);
      try {
        await untilRunning(t.state, t.exited);
        t.replace();
        // The stop and the upgrade check land in the same turn: the stop wins.
        t.signal("SIGTERM");
        t.clock.advance(UPGRADE_CHECK_MS);
        expect(await t.exited).toBe(0);
        expect(t.spawns).toEqual([]);
        const log = readFileSync(join(t.state, "logs", "daemon.log"), "utf8");
        expect(log).not.toContain("restarting on the new binary");
      } finally {
        await t.stop();
      }
    }));

  it("does not start a new binary after an uncaught error during the upgrade drain, and exits 1 as a crash", () =>
    withDaemonTempDir(async (dir) => {
      const uncaught = new EventEmitter();
      // The error arrives as the daemon enters the upgrade drain, before it closes down.
      const t = setup(
        dir,
        (line) => {
          if (line.includes('"to":"draining"') && line.includes(`"reason":"${UPGRADE_REASON}"`)) {
            uncaught.emit("uncaughtException", new Error("thrown during the upgrade drain"));
          }
        },
        uncaught,
      );
      try {
        await untilRunning(t.state, t.exited);
        t.replace();
        t.clock.advance(UPGRADE_CHECK_MS);
        expect(await t.exited).toBe(1);
        expect(t.spawns).toEqual([]);
        const log = readFileSync(join(t.state, "logs", "daemon.log"), "utf8");
        expect(log).toContain("an uncaught exception reached the daemon");
        expect(log).toContain("exiting 1 after an uncaught error; the next start counts a crash");
        const crashes = JSON.parse(readFileSync(join(t.state, CRASH_FILE), "utf8")) as {
          running: { pid: number } | null;
        };
        expect(crashes.running).toMatchObject({ pid: process.pid });
      } finally {
        await t.stop();
      }
    }));
});
