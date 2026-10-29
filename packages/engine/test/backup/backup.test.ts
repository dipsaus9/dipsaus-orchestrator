// The one backup and the daily upkeep (DIPO-65, DIPO-354; 0007): the pre-migration copies beyond
// the two newest are deleted, and maintenance runs once per UTC day, only while no office has
// active work. A failed timer check is logged and the next one still comes (DIPO-119).

import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { backupsDirectory, prunePreMigrationBackups } from "../../src/backup/files";
import { runMaintenance } from "../../src/backup/maintenance";
import { MaintenanceScheduler } from "../../src/backup/scheduler";
import { yieldToEventLoop } from "../../src/platform/clock";
import { DAY_MS } from "../../src/retention/run";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { watchRejections } from "../platform/rejections";
import { insertRequests } from "../retention/helpers";

const noPause = async () => {};

async function withState(fn: (t: TestState, backups: string) => Promise<void>) {
  return withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      // A new database has no backups directory yet: the migration writes no copy (DIPO-122).
      const backups = backupsDirectory(t.state.connection.path);
      mkdirSync(backups, { recursive: true });
      await fn(t, backups);
    } finally {
      t.state.close();
    }
  });
}

function seed(dir: string, names: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), "");
}

const files = (dir: string) => readdirSync(dir).toSorted();

describe("pre-migration backups", () => {
  it("keeps the two newest and leaves other files alone", () =>
    withTempDir((dir) => {
      seed(dir, [
        "pre-v6-20251201T000000.db",
        "pre-v7-20251215T120000.db",
        "pre-v7-20251215T120000-2.db",
        "dipo-20251230.db",
        "other.db",
      ]);
      expect(prunePreMigrationBackups(dir)).toEqual(["pre-v6-20251201T000000.db"]);
      expect(files(dir)).toEqual(
        [
          "dipo-20251230.db",
          "other.db",
          "pre-v7-20251215T120000-2.db",
          "pre-v7-20251215T120000.db",
        ].toSorted(),
      );
    }));

  it("never deletes the copy just written, also after the clock went back", () =>
    withTempDir((dir) => {
      // Newer copies than the one just written: the clock was set back since they were written.
      seed(dir, [
        "pre-v9-20260101T000000.db",
        "pre-v8-20260105T000000.db",
        "pre-v7-20260106T000000.db",
      ]);
      expect(prunePreMigrationBackups(dir, new Set(["pre-v9-20260101T000000.db"]))).toEqual([
        "pre-v8-20260105T000000.db",
      ]);
      expect(files(dir)).toEqual(["pre-v7-20260106T000000.db", "pre-v9-20260101T000000.db"]);
    }));
});

function freePages(t: TestState): void {
  const office = addOffice(t);
  insertRequests(office, 3_000, t.clock.now());
  office.immediate(() => office.run("delete from requests where office_id = $office_id"));
}

describe("maintenance", () => {
  it("vacuums in slices, checkpoints with TRUNCATE and optimizes while idle", () =>
    withState(async (t) => {
      freePages(t);
      const db = t.state.connection;
      const before = db.get<{ freelist_count: number }>("pragma freelist_count")?.freelist_count;
      expect(before).toBeGreaterThan(0);

      const report = await runMaintenance({
        connection: db,
        clock: t.clock,
        idle: () => true,
        pause: noPause,
      });

      expect(report.interrupted).toBe(false);
      expect(report.freedPages).toBe(before ?? 0);
      expect(report.vacuumSteps).toBeGreaterThan(0);
      expect(report.checkpointed).toBe(true);
      expect(report.optimized).toBe(true);
      expect(db.get<{ freelist_count: number }>("pragma freelist_count")?.freelist_count).toBe(0);
      expect(statSync(`${db.path}-wal`).size).toBe(0);
    }));

  it("does nothing while an office has active work and stops when work starts", () =>
    withState(async (t) => {
      freePages(t);
      const busy = await runMaintenance({
        connection: t.state.connection,
        clock: t.clock,
        idle: () => false,
        pause: noPause,
      });
      expect(busy).toMatchObject({ vacuumSteps: 0, checkpointed: false, optimized: false });
      expect(busy.interrupted).toBe(true);

      let calls = 0;
      const stopsAfterOne = await runMaintenance({
        connection: t.state.connection,
        clock: t.clock,
        idle: () => calls++ === 0,
        pause: noPause,
      });
      expect(stopsAfterOne.vacuumSteps).toBe(1);
      expect(stopsAfterOne).toMatchObject({
        checkpointed: false,
        optimized: false,
        interrupted: true,
      });
    }));
});

function scheduler(t: TestState, idle: { value: boolean }) {
  const logs: string[] = [];
  const s = new MaintenanceScheduler({
    database: () => t.state,
    clock: t.clock,
    idle: () => idle.value,
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
    pause: noPause,
  });
  return { s, logs };
}

describe("maintenance scheduler", () => {
  it("runs maintenance once per UTC day, only while idle", () =>
    withState(async (t) => {
      const idle = { value: true };
      const { s } = scheduler(t, idle);
      expect((await s.check())?.interrupted).toBe(false);

      t.clock.advance(60 * 60 * 1000);
      expect(await s.check()).toBeNull();

      // A new day while busy: nothing until no office has active work.
      idle.value = false;
      t.clock.advance(DAY_MS);
      expect(await s.check()).toBeNull();
      idle.value = true;
      expect((await s.check())?.interrupted).toBe(false);
      expect(await s.check()).toBeNull();
    }));

  it("checks on its timer and stops", () =>
    withState(async (t) => {
      const { s, logs } = scheduler(t, { value: true });
      s.start();
      t.clock.advance(60 * 1000);
      await settledUntil(() => logs.includes("database maintenance"));
      await s.stop();
      expect(t.clock.pendingTimers).toBe(0);
    }));

  it("logs a failed timer check once and arms the next one (DIPO-119)", () =>
    withState(async (t) => {
      const logs: string[] = [];
      const warnings: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
      let broken = true;
      const s = new MaintenanceScheduler({
        // The first check finds the database failing, outside the maintenance itself.
        database: () => {
          if (broken) {
            broken = false;
            throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
          }
          return t.state;
        },
        clock: t.clock,
        idle: () => true,
        logger: {
          info: (message) => logs.push(message),
          warn: (message, fields) => warnings.push({ message, fields: fields ?? {} }),
          error: (message, fields) => warnings.push({ message, fields: fields ?? {} }),
        },
        pause: noPause,
      });
      const watch = watchRejections();
      s.start();
      t.clock.advance(60 * 1000);
      await settledUntil(() => t.clock.pendingTimers === 1);
      expect(await watch.stop()).toEqual([]);
      expect(warnings).toEqual([
        {
          message: "the database maintenance check failed",
          fields: { reason: "disk I/O error", errorCode: "SQLITE_IOERR" },
        },
      ]);
      expect(logs).toEqual([]);
      // The next check comes on the hourly timer and maintains as usual.
      t.clock.advance(60 * 60 * 1000);
      await settledUntil(
        () => logs.includes("database maintenance") && t.clock.pendingTimers === 1,
      );
      await s.stop();
      expect(warnings).toHaveLength(1);
      expect(t.clock.pendingTimers).toBe(0);
    }));
});

/** Yields to the event loop until `done` holds; fails after 500 turns. */
async function settledUntil(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500; turn++) {
    if (done()) return;
    await yieldToEventLoop();
  }
  throw new Error("the scheduler did not settle");
}
