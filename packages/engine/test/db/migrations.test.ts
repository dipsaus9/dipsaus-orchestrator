// Migrations runner (DIPO-21, 0007 section 9).

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import {
  backupStamp,
  DatabaseTooNewError,
  migrate,
  MigrationChecksumError,
  MigrationFailedError,
  migrationChecksum,
  type Migration,
} from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { openSqlite } from "../../src/platform/sqlite";
import { localMounts, memoryLogger } from "./helpers";

const ENGINE_VERSION = "0.0.0-test";

const second: Migration = {
  version: 2,
  name: "widgets",
  sql: "create table widgets (office_id text not null, widget_id text not null, primary key (office_id, widget_id)) strict;",
};
const third: Migration = {
  version: 3,
  name: "widget colour",
  run: (db) => db.exec("alter table widgets add column colour text"),
  source: "add widgets.colour text",
};

function options(dir: string, migrations: readonly Migration[], clock = new ManualClock()) {
  return {
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock,
    engineVersion: ENGINE_VERSION,
    migrations,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (caught: unknown) => caught,
  );
}

const backups = (dir: string) => {
  const path = join(dir, "state", "backups");
  return existsSync(path) ? readdirSync(path).toSorted() : [];
};

describe("migrate", () => {
  it("creates offices and schema_migrations as STRICT tables and mirrors the head in user_version", () =>
    withTempDir(async (dir) => {
      const state = await openStateDatabase(options(dir, MIGRATIONS));
      try {
        const db = state.connection;
        const tables = db.all<{ name: string; strict: number }>(
          "select name, strict from pragma_table_list where schema = 'main' and name not like 'sqlite_%' order by name",
        );
        expect(tables).toEqual([
          { name: "offices", strict: 1 },
          { name: "schema_migrations", strict: 1 },
        ]);
        expect(db.get<{ user_version: number }>("pragma user_version")).toEqual({
          user_version: MIGRATIONS.length,
        });
        expect(state.migration).toMatchObject({ from: 0, to: MIGRATIONS.length });
      } finally {
        state.close();
      }
    }));

  it("applies steps in order, records each one and backs up first", () =>
    withTempDir(async (dir) => {
      const clock = new ManualClock();
      const first = await openStateDatabase(options(dir, MIGRATIONS, clock));
      first.close();
      expect(backups(dir)).toEqual([`pre-v1-${backupStamp(clock.now())}.db`]);

      clock.advance(60_000);
      const state = await openStateDatabase(options(dir, [...MIGRATIONS, second, third], clock));
      try {
        const db = state.connection;
        expect(state.migration.from).toBe(1);
        expect(state.migration.to).toBe(3);
        expect(state.migration.backup).toBe(
          join(dir, "state", "backups", `pre-v3-${backupStamp(clock.now())}.db`),
        );
        expect(statSync(state.migration.backup ?? "").mode & 0o777).toBe(0o600);
        const steps: readonly Migration[] = [...MIGRATIONS, second, third];
        expect(
          db.all<Record<string, unknown>>(
            "select version, name, checksum, engine_version from schema_migrations",
          ),
        ).toEqual(
          steps.map((step) => ({
            version: step.version,
            name: step.name,
            checksum: migrationChecksum(step),
            engine_version: ENGINE_VERSION,
          })),
        );
        expect(db.get<{ user_version: number }>("pragma user_version")).toEqual({
          user_version: 3,
        });
        expect(db.all("select name from pragma_table_info('widgets')")).toEqual([
          { name: "office_id" },
          { name: "widget_id" },
          { name: "colour" },
        ]);
      } finally {
        state.close();
      }

      // At the head nothing runs and no backup is written.
      const again = await openStateDatabase(options(dir, [...MIGRATIONS, second, third], clock));
      again.close();
      expect(again.migration.backup).toBeNull();
      expect(backups(dir)).toHaveLength(2);
    }));

  it("rolls back a failing step and leaves user_version unchanged", () =>
    withTempDir(async (dir) => {
      (await openStateDatabase(options(dir, MIGRATIONS))).close();
      const broken: Migration = {
        version: 2,
        name: "broken",
        sql: "create table half (office_id text primary key) strict; insert into nowhere values (1);",
      };
      const error = await failure(openStateDatabase(options(dir, [...MIGRATIONS, broken])));
      expect(error).toBeInstanceOf(MigrationFailedError);
      expect((error as MigrationFailedError).backup).toContain("pre-v2-");
      expect((error as Error).message).toContain((error as MigrationFailedError).backup);

      const db = await openSqlite({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
      });
      try {
        expect(db.get<{ user_version: number }>("pragma user_version")).toEqual({
          user_version: 1,
        });
        expect(db.get("select name from sqlite_schema where name = 'half'")).toBeNull();
        expect(db.all("select version from schema_migrations")).toEqual([{ version: 1 }]);
      } finally {
        db.close();
      }
    }));

  it("refuses a database newer than the binary with 'upgrade dipo'", () =>
    withTempDir(async (dir) => {
      (await openStateDatabase(options(dir, [...MIGRATIONS, second]))).close();
      const error = await failure(openStateDatabase(options(dir, MIGRATIONS)));
      expect(error).toBeInstanceOf(DatabaseTooNewError);
      expect((error as Error).message).toContain("upgrade dipo");
    }));

  it("stops when a recorded checksum differs from the binary's step", () =>
    withTempDir(async (dir) => {
      (await openStateDatabase(options(dir, [...MIGRATIONS, second]))).close();
      const edited: Migration = {
        ...second,
        sql: `${"sql" in second ? second.sql : ""} -- edited`,
      };
      const error = await failure(openStateDatabase(options(dir, [...MIGRATIONS, edited])));
      expect(error).toBeInstanceOf(MigrationChecksumError);
      expect((error as MigrationChecksumError).version).toBe(2);
      expect(backups(dir)).toHaveLength(1);
    }));

  it("rejects steps that are not numbered 1, 2, 3 in order", () =>
    withTempDir(async (dir) => {
      const db = await openSqlite({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
      });
      try {
        const run = (migrations: readonly Migration[]) =>
          failure(
            migrate(db, {
              migrations,
              clock: new ManualClock(),
              logger: memoryLogger(),
              engineVersion: ENGINE_VERSION,
            }),
          );
        expect(await run([...MIGRATIONS, third])).toBeInstanceOf(Error);
        expect(await run([second, ...MIGRATIONS])).toBeInstanceOf(Error);
        expect(db.get<{ user_version: number }>("pragma user_version")).toEqual({
          user_version: 0,
        });
      } finally {
        db.close();
      }
    }));

  it("formats backup times as yyyymmddThhmmss in UTC", () => {
    expect(backupStamp(Date.UTC(2026, 9, 12, 7, 5, 9, 450))).toBe("20261012T070509");
  });
});
