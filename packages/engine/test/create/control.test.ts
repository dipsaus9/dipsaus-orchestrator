// `daemon.status` from the engine's `daemon.*` feature (DIPO-198, DIPO-125): the build commit and
// the offices behind it, answered from memory while a git read hangs, and the active runs.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { buildRegistry } from "../../src/commands/registry";
import { controlFeature, type ControlDeps, sumActiveRuns } from "../../src/create/control";
import { EngineBehindCache } from "../../src/create/engine-behind";
import { DaemonLifecycle } from "../../src/create/lifecycle";
import type { EngineCommitsRead } from "../../src/git/build-commit";
import { createLogger, type Logger } from "../../src/log/logger";

describe("daemon.status build commit (DIPO-198)", () => {
  const OFFICE = "off_01J9ZK5Q8W3V4X6Y7Z00000001" as OfficeId;

  function status(extra: Partial<ControlDeps>) {
    const clock = new ManualClock();
    const registry = buildRegistry([
      controlFeature({
        lifecycle: new DaemonLifecycle(),
        logger: {} as Logger,
        clock,
        startedAt: clock.now(),
        pid: 1,
        version: "0.0.0-test",
        socket: "/s",
        tools: {},
        upgradePending: () => false,
        loadedOffices: () => [OFFICE],
        requestStop: () => {},
        ...extra,
      }),
    ]);
    const read = registry.read("daemon.status");
    if (read === undefined) throw new Error("daemon.status is not registered");
    const result = (read.handle as (ctx: unknown, args: unknown) => unknown)({}, {});
    // A synchronous read: daemon.status answers from memory and never waits on git.
    expect(result instanceof Promise).toBe(false);
    return result as { buildCommit?: string; engineBehind?: unknown; activeRuns?: number };
  }

  it("carries the build commit, dirty suffix included, and the offices behind", () => {
    const result = status({
      buildCommit: "1a2b3c4d5e6f-dirty",
      engineBehind: () => [{ office: OFFICE, name: "repo", commits: 1 }],
    });
    expect(result.buildCommit).toBe("1a2b3c4d5e6f-dirty");
    expect(result.engineBehind).toEqual([{ office: OFFICE, name: "repo", commits: 1 }]);
  });

  it("has neither field when run from source", () => {
    const result = status({});
    expect("buildCommit" in result).toBe(false);
    expect("engineBehind" in result).toBe(false);
  });

  it("counts active runs over the loaded offices (DIPO-125)", () => {
    const B = "off_01J9ZK5Q8W3V4X6Y7Z00000002" as OfficeId;
    const counts = new Map<OfficeId, number>([
      [OFFICE, 2],
      [B, 1],
    ]);
    const offices = [OFFICE, B];
    const result = status({
      loadedOffices: () => offices,
      activeRuns: () => sumActiveRuns(offices, (office) => counts.get(office)),
    });
    expect(result.activeRuns).toBe(3);
    expect(sumActiveRuns([OFFICE, B], (office) => (office === OFFICE ? undefined : 4))).toBe(4);
  });

  it("answers at once while the office's git read never finishes", async () => {
    const clock = new ManualClock();
    const reads: ((read: EngineCommitsRead) => void)[] = [];
    let hang = false;
    const cache = new EngineBehindCache({
      clock,
      logger: createLogger({ clock, sinks: [], component: "test" }),
      loadedOffices: () => [OFFICE],
      source: () => ({
        mainWorktree: "/Users/me/Projects/repo",
        // Once `hang` is set, git never answers: a queue stuck behind a fetch.
        read: () =>
          hang
            ? new Promise<EngineCommitsRead>(() => {})
            : new Promise<EngineCommitsRead>((resolve) => reads.push(resolve)),
      }),
    });
    const deps = { buildCommit: "1a2b3c4d5e6f", engineBehind: () => cache.rows() };

    // Nothing read yet: no rows, and the first read is under way in the background.
    expect(status(deps).engineBehind).toEqual([]);
    expect(cache.reading(OFFICE)).toBe(true);
    reads.shift()?.({ kind: "count", commits: 2 });
    await cache.refresh(OFFICE);

    // The next read hangs; status keeps answering with the cached row, without stacking reads.
    hang = true;
    void cache.refreshAll();
    for (let i = 0; i < 50; i += 1) {
      expect(status(deps).engineBehind).toEqual([{ office: OFFICE, name: "repo", commits: 2 }]);
    }
    expect(cache.reading(OFFICE)).toBe(true);
    cache.stop();
  });
});

describe("daemon.resumeScheduling (0020)", () => {
  it("lifts the offices' starts paused, and changes nothing once nothing is left (0005)", () => {
    const clock = new ManualClock();
    const lifecycle = new DaemonLifecycle();
    lifecycle.transition("recovering", "setup");
    lifecycle.transition("running", "setup");
    const lifts: string[] = [];
    let paused = 1;
    const registry = buildRegistry([
      controlFeature({
        lifecycle,
        logger: createLogger({ clock, sinks: [], component: "test" }),
        clock,
        startedAt: clock.now(),
        pid: 1,
        version: "0.0.0-test",
        socket: "/s",
        tools: {},
        upgradePending: () => false,
        loadedOffices: () => [],
        liftStartsPaused: (why) => {
          lifts.push(why);
          const lifted = paused;
          paused = 0;
          return lifted;
        },
        requestStop: () => {},
      }),
    ]);
    const command = registry.command("daemon.resumeScheduling");
    if (command === undefined) throw new Error("daemon.resumeScheduling is not registered");
    const resume = () => (command.handle as (ctx: unknown, args: unknown) => unknown)({}, {});
    expect(resume()).toEqual({ result: { state: "running" }, changed: true });
    expect(lifts).toEqual(["the maintainer ran dipo daemon resume-scheduling"]);
    expect(lifecycle.state).toBe("running");
    // Nothing left to lift: target state, it changes nothing.
    expect(resume()).toEqual({ result: { state: "running" }, changed: false });
  });

  it("refuses with database.unavailable while the state database cannot be used", () => {
    const clock = new ManualClock();
    const lifecycle = new DaemonLifecycle();
    lifecycle.transition("recovering", "setup");
    lifecycle.holdUnavailable({ details: { reason: "damaged" }, text: "damaged" });
    const lifts: string[] = [];
    const registry = buildRegistry([
      controlFeature({
        lifecycle,
        logger: createLogger({ clock, sinks: [], component: "test" }),
        clock,
        startedAt: clock.now(),
        pid: 1,
        version: "0.0.0-test",
        socket: "/s",
        tools: {},
        upgradePending: () => false,
        loadedOffices: () => [],
        liftStartsPaused: (why) => lifts.push(why),
        requestStop: () => {},
      }),
    ]);
    const command = registry.command("daemon.resumeScheduling");
    if (command === undefined) throw new Error("daemon.resumeScheduling is not registered");
    let refused: unknown;
    try {
      (command.handle as (ctx: unknown, args: unknown) => unknown)({}, {});
    } catch (error) {
      refused = error;
    }
    expect((refused as { error?: { code?: string } } | undefined)?.error?.code).toBe(
      "database.unavailable",
    );
    expect(lifts).toEqual([]);
  });
});
