// Upgrades while the daemon runs (0005) on the manual clock: a changed executable gives `upgrade
// pending` at the next 60 s check, and the daemon never restarts itself.

import { describe, expect, it } from "bun:test";

import { createLogger, type ExecutableStamp } from "@dipsaus-orchestrator/engine/platform";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { UPGRADE_CHECK_MS, UpgradeWatcher } from "../../src/upgrade";

const OLD: ExecutableStamp = { dev: 1, ino: 10, size: 100, mtimeMs: 1000 };
const NEW: ExecutableStamp = { dev: 1, ino: 11, size: 120, mtimeMs: 2000 };

function setup() {
  const clock = new ManualClock();
  let stamp: ExecutableStamp | null = OLD;
  const watcher = new UpgradeWatcher({
    clock,
    logger: createLogger({ clock, sinks: [], component: "test" }),
    executable: "/usr/local/bin/dipo",
    readStamp: () => stamp,
  });
  watcher.start();
  return { clock, watcher, replace: (next: ExecutableStamp | null) => void (stamp = next) };
}

describe("UpgradeWatcher", () => {
  it("reports upgrade pending at the first check after the executable changed", () => {
    const t = setup();
    t.clock.advance(UPGRADE_CHECK_MS);
    expect(t.watcher.pending).toBe(false);
    t.replace(NEW);
    t.clock.advance(UPGRADE_CHECK_MS - 1);
    expect(t.watcher.pending).toBe(false);
    t.clock.advance(1);
    expect(t.watcher.pending).toBe(true);
  });

  it("does not report a file that is missing for a moment while it is replaced", () => {
    const t = setup();
    t.replace(null);
    t.clock.advance(UPGRADE_CHECK_MS);
    expect(t.watcher.pending).toBe(false);
    t.replace(NEW);
    t.clock.advance(UPGRADE_CHECK_MS);
    expect(t.watcher.pending).toBe(true);
  });

  it("stops checking when stopped, and never starts without a readable executable", () => {
    const t = setup();
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
    });
    blind.start();
    clock.advance(UPGRADE_CHECK_MS * 2);
    expect(blind.pending).toBe(false);
  });
});
