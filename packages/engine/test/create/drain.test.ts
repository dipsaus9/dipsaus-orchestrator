// The drain (DIPO-68, 0006 decision 7) on the manual clock: it waits for pending work and for the
// daemon's own children, is capped at 20 s, or 60 s while workers are being stopped, and kills the
// process groups of the children still running at the cap.

import { describe, expect, it } from "bun:test";

import { createLogger } from "../../src/log/logger";
import { ChildProcesses } from "../../src/platform/process";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  DRAIN_CAP_MS,
  DRAIN_CAP_STOP_WORKERS_MS,
  drain,
  type DrainOptions,
  type DrainResult,
  type StoppedWorkers,
} from "../../src/create/drain";
import { DaemonLifecycle } from "../../src/create/lifecycle";

/** A child process stand-in: `kill` records the signal and ends it, so nothing real is signalled. */
class FakeChildren {
  readonly killed: string[] = [];
  readonly #pending = new Map<number, () => void>();
  readonly #children = new ChildProcesses();

  add(pid: number): () => void {
    const { promise: exited, resolve } = Promise.withResolvers<void>();
    this.#children.track({ pid, exited });
    this.#pending.set(pid, resolve);
    return resolve;
  }

  get tracker(): DrainOptions["children"] {
    const children = this.#children;
    return {
      get size() {
        return children.size;
      },
      waitAll: () => children.waitAll(),
      killGroups: (signal = "SIGKILL") => {
        const pids = children.pids();
        for (const pid of pids) {
          this.killed.push(`${pid}:${signal}`);
          this.#pending.get(pid)?.();
        }
        return pids;
      },
    };
  }
}

function setup(state: "running" | "recovering" = "running") {
  const clock = new ManualClock();
  const lines: string[] = [];
  const logger = createLogger({ clock, sinks: [(line) => lines.push(line)], component: "test" });
  const lifecycle = new DaemonLifecycle();
  lifecycle.transition("recovering", "test");
  if (state === "running") lifecycle.transition("running", "test");
  const children = new FakeChildren();
  return { clock, lines, logger, lifecycle, children };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function track(promise: Promise<DrainResult>) {
  const box: { result: DrainResult | null } = { result: null };
  void promise.then((result) => {
    box.result = result;
  });
  return box;
}

describe("drain", () => {
  it("enters draining and finishes at once when nothing is pending", async () => {
    const { clock, logger, lifecycle, children } = setup();
    const changes: string[] = [];
    lifecycle.onTransition((c) => changes.push(`${c.from}>${c.to}:${c.reason}`));
    const result = await drain({
      lifecycle,
      children: children.tracker,
      clock,
      logger,
      request: { reason: "SIGTERM", stopWorkers: false },
    });
    expect(result).toEqual({ capped: false, killed: [] });
    expect(changes).toEqual(["running>draining:SIGTERM"]);
    expect(clock.pendingTimers).toBe(0);
  });

  it("waits for pending work and for every child before it finishes", async () => {
    const { clock, logger, lifecycle, children } = setup();
    const endWork = lifecycle.beginWork();
    const endChild = children.add(424242);
    const box = track(
      drain({
        lifecycle,
        children: children.tracker,
        clock,
        logger,
        request: { reason: "SIGINT", stopWorkers: false },
      }),
    );
    clock.advance(DRAIN_CAP_MS - 1);
    await settle();
    expect(box.result).toBeNull();
    endWork?.();
    await settle();
    expect(box.result).toBeNull();
    endChild();
    await settle();
    expect(box.result).toEqual({ capped: false, killed: [] });
    expect(children.killed).toEqual([]);
  });

  it("kills the process groups of children still running at the 20 s cap", async () => {
    const { clock, lines, logger, lifecycle, children } = setup();
    children.add(515151);
    const box = track(
      drain({
        lifecycle,
        children: children.tracker,
        clock,
        logger,
        request: { reason: "SIGTERM", stopWorkers: false },
      }),
    );
    await settle();
    clock.advance(DRAIN_CAP_MS);
    await settle();
    expect(box.result).toEqual({ capped: true, killed: [515151] });
    expect(children.killed).toEqual(["515151:SIGKILL"]);
    expect(lines.some((line) => line.includes("the drain reached its cap"))).toBe(true);
  });

  it("exits at the cap even when pending work never ends", async () => {
    const { clock, logger, lifecycle, children } = setup();
    lifecycle.beginWork();
    const box = track(
      drain({
        lifecycle,
        children: children.tracker,
        clock,
        logger,
        request: { reason: "SIGTERM", stopWorkers: false },
      }),
    );
    await settle();
    clock.advance(DRAIN_CAP_MS);
    await settle();
    expect(box.result).toEqual({ capped: true, killed: [] });
  });

  it("uses the 60 s cap while workers are being stopped", async () => {
    const { clock, logger, lifecycle, children } = setup();
    let stopped = false;
    const stopping = Promise.withResolvers<StoppedWorkers>();
    const finishStopping = () => {
      stopped = true;
      stopping.resolve({ stopped: 1, deciding: 0, running: 0 });
    };
    const options: DrainOptions = {
      lifecycle,
      children: children.tracker,
      clock,
      logger,
      request: { reason: "daemon.stop", stopWorkers: true },
      stopWorkers: () => stopping.promise,
    };
    const box = track(drain(options));
    await settle();
    clock.advance(DRAIN_CAP_MS);
    await settle();
    expect(box.result).toBeNull();
    clock.advance(DRAIN_CAP_STOP_WORKERS_MS - DRAIN_CAP_MS - 1);
    await settle();
    expect(box.result).toBeNull();
    finishStopping();
    await settle();
    expect(stopped).toBe(true);
    expect(box.result).toEqual({ capped: false, killed: [] });
  });

  it("drains from recovering, as SIGTERM during startup does", async () => {
    const { clock, logger, lifecycle, children } = setup("recovering");
    await drain({
      lifecycle,
      children: children.tracker,
      clock,
      logger,
      request: { reason: "SIGTERM", stopWorkers: false },
    });
    expect(lifecycle.state).toBe("draining");
  });
});

const stopDrain = async (stopWorkers?: () => Promise<StoppedWorkers>) => {
  const { clock, logger, lifecycle, children, lines } = setup();
  let called = 0;
  await drain({
    lifecycle,
    children: children.tracker,
    clock,
    logger,
    request: { reason: "daemon.stop", stopWorkers: true },
    ...(stopWorkers === undefined
      ? {}
      : {
          stopWorkers: () => {
            called += 1;
            return stopWorkers();
          },
        }),
  });
  const said = lines.map((line) => JSON.parse(line) as { msg: string; level: string });
  return { called, said };
};

describe("drain with stopWorkers (DIPO-315)", () => {
  it("stops the workers before the drain ends, and the log line says how many", async () => {
    const { called, said } = await stopDrain(() =>
      Promise.resolve({ stopped: 2, deciding: 1, running: 0 }),
    );
    expect(called).toBe(1);
    const line = said.find((entry) => entry.msg.startsWith("stopped the workers"));
    expect(line).toMatchObject({ msg: "stopped the workers; every one exited", level: "info" });
    expect(said.findIndex((entry) => entry.msg === "drained")).toBeGreaterThan(
      said.indexOf(line as (typeof said)[number]),
    );
  });

  it("warns when a stopped worker had not exited yet, and says when there was none", async () => {
    const late = await stopDrain(() => Promise.resolve({ stopped: 1, deciding: 0, running: 1 }));
    expect(late.said.find((entry) => entry.msg.startsWith("stopped the workers"))?.level).toBe(
      "warn",
    );
    const none = await stopDrain(() => Promise.resolve({ stopped: 0, deciding: 0, running: 0 }));
    expect(none.said.some((entry) => entry.msg === "no live workers to stop")).toBe(true);
  });

  it("never calls it without stopWorkers in the request", async () => {
    const { clock, logger, lifecycle, children } = setup();
    let called = 0;
    await drain({
      lifecycle,
      children: children.tracker,
      clock,
      logger,
      request: { reason: "SIGTERM", stopWorkers: false },
      stopWorkers: () => {
        called += 1;
        return Promise.resolve({ stopped: 0, deciding: 0, running: 0 });
      },
    });
    expect(called).toBe(0);
  });
});
