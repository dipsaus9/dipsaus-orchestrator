// Daily backups and maintenance (DIPO-65; 0007 sections 1, 7 and 10): a `VACUUM INTO` copy written
// from a Bun Worker and checked with `quick_check`, 3 daily and 2 pre-migration copies kept, and
// maintenance only while no office has active work.

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { writeDailyBackup } from "../../src/backup/daily";
import { backupsDirectory, dailyBackupName, pruneBackups } from "../../src/backup/files";
import { runMaintenance } from "../../src/backup/maintenance";
import { MaintenanceScheduler } from "../../src/backup/scheduler";
import { DAY_MS } from "../../src/retention/run";
import { addOffice, openTestState, type TestState } from "../commands/helpers";
import { insertRequests } from "../retention/helpers";

const noPause = async () => {};

async function withState(fn: (t: TestState, backups: string) => Promise<void>) {
  return withTempDir(async (dir) => {
    const t = await openTestState(dir);
    try {
      await fn(t, backupsDirectory(t.state.connection.path));
    } finally {
      t.state.close();
    }
  });
}

function seed(dir: string, names: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), "");
}

async function failing(_source: string, target: string): Promise<void> {
  writeFileSync(target, "half a copy");
  throw new Error("quick_check: page 3 is never used");
}

const files = (dir: string) => readdirSync(dir).toSorted();

function quickCheck(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return String(Object.values(db.query("pragma quick_check").get() as object)[0]);
  } finally {
    db.close();
  }
}

describe("daily backup", () => {
  it("is written from a Worker, passes quick_check, and the oldest copy beyond three is deleted", () =>
    withState(async (t, backups) => {
      insertRequests(addOffice(t), 10, t.clock.now());
      seed(backups, [
        "dipo-20251228.db",
        "dipo-20251229.db",
        "dipo-20251230.db",
        "pre-v6-20251201T000000.db",
        "pre-v7-20251215T120000.db",
        "pre-v7-20251215T120000-2.db",
      ]);

      // Opening the test database migrated it, which wrote the newest pre-migration copy.
      const migrated = basename(t.state.migration.backup ?? "");
      expect(migrated).toStartWith("pre-v");

      const result = await writeDailyBackup({
        dbPath: t.state.connection.path,
        now: t.clock.now(),
      });

      expect(result.written).toBe(true);
      expect(result.path).toBe(join(backups, "dipo-20260101.db"));
      expect(result.removed.toSorted()).toEqual([
        "dipo-20251228.db",
        "pre-v6-20251201T000000.db",
        "pre-v7-20251215T120000.db",
      ]);
      expect(files(backups)).toEqual(
        [
          "dipo-20251229.db",
          "dipo-20251230.db",
          "dipo-20260101.db",
          migrated,
          "pre-v7-20251215T120000-2.db",
        ].toSorted(),
      );
      expect(quickCheck(result.path)).toBe("ok");
      const copy = new Database(result.path, { readonly: true });
      try {
        expect(copy.query("select count(*) as n from requests").get()).toEqual({ n: 10 });
      } finally {
        copy.close();
      }
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
      expect(statSync(result.path).mtimeMs).toBe(t.clock.now());
    }));

  it("leaves no copy when the snapshot or its check fails, and skips a day already written", () =>
    withState(async (t, backups) => {
      const dbPath = t.state.connection.path;
      await expect(
        writeDailyBackup({ dbPath, now: t.clock.now(), vacuum: failing }),
      ).rejects.toThrow("quick_check");
      expect(files(backups).filter((name) => name.startsWith("dipo-"))).toEqual([]);

      seed(backups, [dailyBackupName(t.clock.now())]);
      const again = await writeDailyBackup({ dbPath, now: t.clock.now(), vacuum: failing });
      expect(again).toEqual({
        path: join(backups, dailyBackupName(t.clock.now())),
        written: false,
        removed: [],
      });
    }));

  it("prunes with configurable counts", () =>
    withTempDir((dir) => {
      seed(dir, ["dipo-20260101.db", "dipo-20260102.db", "pre-v1-20260101T000000.db", "other.db"]);
      expect(pruneBackups(dir, { daily: 1, preMigration: 0 }).toSorted()).toEqual([
        "dipo-20260101.db",
        "pre-v1-20260101T000000.db",
      ]);
      expect(files(dir)).toEqual(["dipo-20260102.db", "other.db"]);
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
  const written: string[] = [];
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
    vacuum: async (_source, target) => {
      writeFileSync(target, "copy");
      written.push(target);
    },
  });
  return { s, written, logs };
}

describe("maintenance scheduler", () => {
  it("backs up once per day while idle and at the latest after 24 hours while busy", () =>
    withState(async (t, backups) => {
      const idle = { value: true };
      const { s, written } = scheduler(t, idle);
      const first = await s.check();
      expect(first.backup?.path).toBe(join(backups, "dipo-20260101.db"));
      expect(first.maintenance?.interrupted).toBe(false);

      t.clock.advance(60 * 60 * 1000);
      const second = await s.check();
      expect(second).toEqual({ backup: null, maintenance: null });

      // A new day while busy: no copy until 24 hours after the last one.
      idle.value = false;
      t.clock.advance(DAY_MS - 2 * 60 * 60 * 1000);
      expect((await s.check()).backup).toBeNull();
      t.clock.advance(60 * 60 * 1000);
      const forced = await s.check();
      expect(forced.backup?.path).toBe(join(backups, "dipo-20260102.db"));
      expect(forced.maintenance).toBeNull();
      expect(written).toHaveLength(2);

      // Idle again on the same day: maintenance runs once, no second copy.
      idle.value = true;
      const later = await s.check();
      expect(later.backup).toBeNull();
      expect(later.maintenance?.interrupted).toBe(false);
      expect((await s.check()).maintenance).toBeNull();
    }));

  it("checks on its timer and stops", () =>
    withState(async (t) => {
      const { s, written } = scheduler(t, { value: true });
      s.start();
      t.clock.advance(60 * 1000);
      await s.stop();
      expect(written).toHaveLength(1);
      expect(t.clock.pendingTimers).toBe(0);
    }));
});
