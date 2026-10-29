// Upgrades while the daemon runs (DIPO-70, 0006 decision 14) on the manual clock: a changed
// executable gives `upgrade pending` at the next 60 s check; with `autoRestartOnUpgrade` the
// daemon drains once no engine step runs, and only once.

import { describe, expect, it } from "bun:test";

import { createLogger, type ExecutableStamp } from "@dipsaus-orchestrator/engine";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { UPGRADE_CHECK_MS, UpgradeWatcher } from "../../src/upgrade";

const OLD: ExecutableStamp = { dev: 1, ino: 10, size: 100, mtimeMs: 1000 };
const NEW: ExecutableStamp = { dev: 1, ino: 11, size: 120, mtimeMs: 2000 };

function setup(options: { autoRestart: boolean; busy?: () => boolean }) {
  const clock = new ManualClock();
  let stamp: ExecutableStamp | null = OLD;
  let restarts = 0;
  const watcher = new UpgradeWatcher({
    clock,
    logger: createLogger({ clock, sinks: [], component: "test" }),
    executable: "/usr/local/bin/dipo",
    readStamp: () => stamp,
    autoRestart: options.autoRestart,
    restart: () => void (restarts += 1),
  });
  watcher.start(options.busy ?? (() => false));
  return {
    clock,
    watcher,
    replace: (next: ExecutableStamp | null) => void (stamp = next),
    restarts: () => restarts,
  };
}

describe("UpgradeWatcher", () => {
  it("reports upgrade pending at the first check after the executable changed", () => {
    const t = setup({ autoRestart: false });
    t.clock.advance(UPGRADE_CHECK_MS);
    expect(t.watcher.pending).toBe(false);
    t.replace(NEW);
    t.clock.advance(UPGRADE_CHECK_MS - 1);
    expect(t.watcher.pending).toBe(false);
    t.clock.advance(1);
    expect(t.watcher.pending).toBe(true);
    // Off by default (0006 open question 6): pending is only reported.
    t.clock.advance(UPGRADE_CHECK_MS * 5);
    expect(t.restarts()).toBe(0);
  });

  it("does not report a file that is missing for a moment while it is replaced", () => {
    const t = setup({ autoRestart: true });
    t.replace(null);
    t.clock.advance(UPGRADE_CHECK_MS);
    expect(t.watcher.pending).toBe(false);
    t.replace(NEW);
    t.clock.advance(UPGRADE_CHECK_MS);
    expect(t.watcher.pending).toBe(true);
  });

  it("with autoRestartOnUpgrade drains once no engine step is running, and only once", () => {
    let busy = true;
    const t = setup({ autoRestart: true, busy: () => busy });
    t.replace(NEW);
    t.clock.advance(UPGRADE_CHECK_MS);
    expect(t.watcher.pending).toBe(true);
    expect(t.restarts()).toBe(0);
    t.clock.advance(UPGRADE_CHECK_MS * 3);
    expect(t.restarts()).toBe(0);
    busy = false;
    t.clock.advance(UPGRADE_CHECK_MS);
    expect(t.restarts()).toBe(1);
    expect(t.watcher.restarting).toBe(true);
    t.clock.advance(UPGRADE_CHECK_MS * 3);
    expect(t.restarts()).toBe(1);
  });

  it("stops checking when stopped, and never starts without a readable executable", () => {
    const t = setup({ autoRestart: true });
    t.watcher.stop();
    t.replace(NEW);
    t.clock.advance(UPGRADE_CHECK_MS * 2);
    expect(t.watcher.pending).toBe(false);

    const clock = new ManualClock();
    const blind = new UpgradeWatcher({
      clock,
      logger: createLogger({ clock, sinks: [], component: "test" }),
      executable: "/gone",
      readStamp: () => null,
      autoRestart: true,
      restart: () => {
        throw new Error("must not restart");
      },
    });
    blind.start(() => false);
    clock.advance(UPGRADE_CHECK_MS * 2);
    expect(blind.pending).toBe(false);
  });
});
