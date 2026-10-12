// `dipo daemon --foreground` in-process with `daemon.autoRestartOnUpgrade: true` (DIPO-70, 0006
// decision 14) on the manual clock: a changed executable drains the daemon and starts the new
// binary; a stop requested before the watcher fires (a signal, `daemon.stop`, a restart) ends the
// daemon without starting anything. State, runtime directory and temp files stay under the test's
// temp directory, and the spawn of the new binary is recorded, never run.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DetachedSpawnOptions, ExecutableStamp } from "@dipsaus-orchestrator/engine";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { runForeground } from "../../src/foreground";
import type { DaemonIo } from "../../src/io";
import { UPGRADE_CHECK_MS } from "../../src/upgrade";

const OLD: ExecutableStamp = { dev: 1, ino: 10, size: 100, mtimeMs: 1000 };
const NEW: ExecutableStamp = { dev: 1, ino: 11, size: 120, mtimeMs: 2000 };

function setup(dir: string) {
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "config.yaml"), "version: 1\ndaemon:\n  autoRestartOnUpgrade: true\n");
  const clock = new ManualClock();
  let signal: ((name: string) => void) | null = null;
  let stamp = OLD;
  const spawns: DetachedSpawnOptions[] = [];
  const io: DaemonIo = {
    writeLine: () => {},
    writeError: () => {},
    env: {
      DIPO_HOME: state,
      DIPO_RUNTIME_DIR: join(dir, "run"),
      DIPO_TMP: dir,
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
  };
  const exited = runForeground([], io, {
    readExecutableStamp: () => stamp,
    spawnDetached: (options) => {
      spawns.push(options);
      return { pid: 1 };
    },
  });
  return {
    state,
    clock,
    exited,
    spawns,
    replace: () => void (stamp = NEW),
    signal: (name: string) => signal?.(name),
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
    withTempDir(async (dir) => {
      const t = setup(dir);
      await untilRunning(t.state, t.exited);
      t.replace();
      t.clock.advance(UPGRADE_CHECK_MS);
      expect(await t.exited).toBe(0);
      expect(t.spawns).toHaveLength(1);
      expect(t.spawns[0]?.cmd.slice(-4)).toEqual(["daemon", "--foreground", "--log-level", "info"]);
      expect(t.spawns[0]?.env["BUN_OPTIONS"]).toBeUndefined();
      expect(existsSync(join(t.state, "dipo.pid"))).toBe(false);
    }));

  it("does not start a new binary when a stop was requested before the watcher fired", () =>
    withTempDir(async (dir) => {
      const t = setup(dir);
      await untilRunning(t.state, t.exited);
      t.replace();
      // The stop and the upgrade check land in the same turn: the stop wins.
      t.signal("SIGTERM");
      t.clock.advance(UPGRADE_CHECK_MS);
      expect(await t.exited).toBe(0);
      expect(t.spawns).toEqual([]);
      const log = readFileSync(join(t.state, "logs", "daemon.log"), "utf8");
      expect(log).not.toContain("restarting on the new binary");
    }));
});
