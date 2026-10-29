// The engine-behind cache (DIPO-198): `daemon.status` reads the counts from memory, the reads run
// in the background with at most one in flight per office, and a failed read keeps the last count.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import type { EngineCommitsRead } from "../../src/git/build-commit";
import { createLogger } from "../../src/log/logger";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import {
  ENGINE_BEHIND_REFRESH_MS,
  EngineBehindCache,
  engineBehindRows,
} from "../../src/create/engine-behind";

const A = "off_01J9ZK5Q8W3V4X6Y7Z0000000A" as OfficeId;
const B = "off_01J9ZK5Q8W3V4X6Y7Z0000000B" as OfficeId;

/** A read the test settles by hand. */
interface Pending {
  readonly office: OfficeId;
  settle(read: EngineCommitsRead): void;
  fail(error: Error): void;
}

function setup(options: { offices?: OfficeId[]; noGit?: OfficeId[] } = {}) {
  const clock = new ManualClock();
  const lines: string[] = [];
  const logger = createLogger({
    clock,
    sinks: [(line) => lines.push(line)],
    component: "test",
    level: "debug",
  });
  const loaded = [...(options.offices ?? [A])];
  const pending: Pending[] = [];
  const cache = new EngineBehindCache({
    clock,
    logger,
    loadedOffices: () => loaded,
    source: (office) =>
      options.noGit?.includes(office) === true
        ? undefined
        : {
            mainWorktree: `/Users/me/Projects/${office === A ? "alpha" : "beta"}`,
            read: () =>
              new Promise<EngineCommitsRead>((resolve, reject) => {
                pending.push({ office, settle: resolve, fail: reject });
              }),
          },
  });
  /** Settles the oldest pending read of `office`, then lets the cache take the result. */
  const settle = async (office: OfficeId, read: EngineCommitsRead) => {
    const index = pending.findIndex((entry) => entry.office === office);
    if (index < 0) throw new Error(`no pending read of ${office}`);
    const [entry] = pending.splice(index, 1);
    entry?.settle(read);
    await cache.refresh(office);
  };
  return { clock, lines, loaded, pending, cache, settle };
}

describe("EngineBehindCache", () => {
  it("answers rows at once with nothing while the first read hangs", () => {
    const { cache, pending } = setup();
    expect(cache.rows()).toEqual([]);
    expect(pending).toHaveLength(1);
    expect(cache.reading(A)).toBe(true);
  });

  it("serves the count once the read finished, named after the main checkout", async () => {
    const { cache, settle } = setup();
    cache.rows();
    await settle(A, { kind: "count", commits: 2 });
    expect(cache.rows()).toEqual([{ office: A, name: "alpha", commits: 2 }]);
  });

  it("keeps at most one read in flight per office however often status asks", () => {
    const { cache, pending } = setup({ offices: [A, B] });
    for (let i = 0; i < 20; i += 1) cache.rows();
    void cache.refresh(A);
    void cache.refreshAll();
    expect(pending.map((entry) => entry.office).toSorted()).toEqual([A, B]);
  });

  it("leaves out an office whose repository lacks the build commit", async () => {
    const { cache, settle, pending } = setup();
    cache.rows();
    await settle(A, { kind: "none" });
    expect(cache.rows()).toEqual([]);
    // Known to have nothing: status does not start another read.
    expect(pending).toHaveLength(0);
  });

  it("keeps the last count and logs at debug when a read fails", async () => {
    const { cache, settle, lines, pending } = setup();
    cache.rows();
    await settle(A, { kind: "count", commits: 1 });
    void cache.refreshAll();
    await settle(A, { kind: "failed", detail: "git rev-list timed out" });
    expect(cache.rows()).toEqual([{ office: A, name: "alpha", commits: 1 }]);
    expect(lines.some((line) => line.includes("debug") && line.includes("timed out"))).toBe(true);

    void cache.refreshAll();
    const entry = pending.shift();
    entry?.fail(new Error("spawn failed"));
    await cache.refresh(A);
    expect(cache.rows()).toEqual([{ office: A, name: "alpha", commits: 1 }]);
  });

  it("replaces the count with what the next read finds", async () => {
    const { cache, settle } = setup();
    cache.rows();
    await settle(A, { kind: "count", commits: 1 });
    void cache.refreshAll();
    await settle(A, { kind: "count", commits: 3 });
    expect(cache.rows()).toEqual([{ office: A, name: "alpha", commits: 3 }]);
    void cache.refreshAll();
    await settle(A, { kind: "none" });
    expect(cache.rows()).toEqual([]);
  });

  it("reads on start and again each refresh interval, until stopped", async () => {
    const { cache, clock, pending, settle } = setup();
    cache.start();
    expect(pending).toHaveLength(1);
    // A read still in flight when the interval comes round is not doubled.
    clock.advance(ENGINE_BEHIND_REFRESH_MS);
    expect(pending).toHaveLength(1);
    await settle(A, { kind: "count", commits: 1 });
    clock.advance(ENGINE_BEHIND_REFRESH_MS);
    expect(pending).toHaveLength(1);
    await settle(A, { kind: "count", commits: 2 });
    cache.stop();
    clock.advance(ENGINE_BEHIND_REFRESH_MS * 5);
    expect(pending).toHaveLength(0);
    expect(clock.pendingTimers).toBe(0);
  });

  it("never rejects when looking up an office's git throws", async () => {
    const clock = new ManualClock();
    const lines: string[] = [];
    const cache = new EngineBehindCache({
      clock,
      logger: createLogger({
        clock,
        sinks: [(line) => lines.push(line)],
        component: "test",
        level: "debug",
      }),
      loadedOffices: () => [A],
      source: () => {
        throw new Error("office gone");
      },
    });
    expect(cache.rows()).toEqual([]);
    await cache.refresh(A);
    expect(cache.reading(A)).toBe(false);
    expect(lines.some((line) => line.includes("office gone"))).toBe(true);
  });

  it("drops offices that are no longer loaded and offices without git", async () => {
    const { cache, settle, loaded } = setup({ offices: [A, B], noGit: [B] });
    cache.rows();
    await settle(A, { kind: "count", commits: 1 });
    expect(cache.rows()).toEqual([{ office: A, name: "alpha", commits: 1 }]);
    loaded.splice(0, 1);
    expect(cache.rows()).toEqual([]);
    await cache.refreshAll();
    loaded.push(A);
    // Forgotten on unload: a fresh read starts, and nothing is shown until it finishes.
    expect(cache.rows()).toEqual([]);
    expect(cache.reading(A)).toBe(true);
  });
});

describe("engineBehindRows", () => {
  it("skips offices without a count and names each by its main checkout's basename", () => {
    const known = new Map([
      [A, { mainWorktree: "/srv/repos/alpha", commits: 0 }],
      [B, { mainWorktree: "/srv/repos/beta", commits: null }],
    ]);
    const C = "off_01J9ZK5Q8W3V4X6Y7Z0000000C" as OfficeId;
    expect(engineBehindRows([B, A, C], (office) => known.get(office))).toEqual([
      { office: A, name: "alpha", commits: 0 },
    ]);
  });
});
