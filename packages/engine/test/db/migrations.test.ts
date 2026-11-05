// Migrations runner (DIPO-21, 0007).

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { databaseFailure } from "../../src/create/recovery";
import {
  backupStamp,
  DatabaseBeforeSquashError,
  DatabaseTooNewError,
  migrate,
  MigrationChecksumError,
  MigrationFailedError,
  migrationChecksum,
  PRE_SQUASH_FIRST_STEP,
  SchemaDriftError,
  type Migration,
} from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { openSqlite } from "../../src/platform/sqlite";
import { localMounts, memoryLogger } from "./helpers";

const ENGINE_VERSION = "0.0.0-test";

// The runner tests stack their own steps on a small first step of their own, so a change to the
// base schema never shifts them.
const BASE: readonly Migration[] = [
  {
    version: 1,
    name: "offices and schema_migrations, for the runner tests",
    sql: `
create table schema_migrations (
  version integer primary key,
  name text not null,
  checksum text not null,
  engine_version text not null,
  applied_at integer not null
) strict;
create table offices (office_id text primary key, path text not null) strict;
`,
  },
];

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
      const state = await openStateDatabase(options(dir, BASE));
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
          user_version: BASE.length,
        });
        expect(state.migration).toMatchObject({ from: 0, to: BASE.length });
      } finally {
        state.close();
      }
    }));

  it("writes no backup for a new empty database and returns backup null (DIPO-122)", () =>
    withTempDir(async (dir) => {
      const state = await openStateDatabase(options(dir, BASE));
      state.close();
      expect(state.migration).toMatchObject({ from: 0, to: BASE.length, backup: null });
      expect(backups(dir)).toEqual([]);
    }));

  it("backs up a database at version 0 that already holds user tables (DIPO-122)", () =>
    withTempDir(async (dir) => {
      // A legacy file, or one changed outside dipo: tables but no user_version.
      const legacy = await openSqlite({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
      });
      try {
        legacy.exec("create table legacy (note text not null) strict");
        legacy.run("insert into legacy (note) values ($note)", { note: "keep me" });
      } finally {
        legacy.close();
      }

      // The backup is written and the steps run; the legacy table is not one of theirs, so the
      // schema check refuses the database and names the backup (DIPO-426).
      const clock = new ManualClock();
      const error = await failure(openStateDatabase(options(dir, BASE, clock)));
      const name = `pre-v1-${backupStamp(clock.now())}.db`;
      const expected = join(dir, "state", "backups", name);
      expect(error).toBeInstanceOf(SchemaDriftError);
      expect((error as SchemaDriftError).objects).toEqual([
        "table legacy is not built by the migrations",
      ]);
      expect((error as SchemaDriftError).backup).toBe(expected);
      expect(backups(dir)).toEqual([name]);

      // The copy was taken before the first step: the legacy row, none of migration 1's tables.
      const copy = new Database(expected, { readonly: true });
      try {
        expect(copy.query("select note from legacy").all()).toEqual([{ note: "keep me" }]);
        expect(
          copy
            .query(
              "select name from sqlite_schema where type = 'table' and name in ('offices', 'schema_migrations')",
            )
            .all(),
        ).toEqual([]);
      } finally {
        copy.close();
      }
    }));

  for (const table of ["sqliteXdata", "SQLiteData"]) {
    it(`backs up a version 0 database whose only table is ${table}, not an internal name (DIPO-122)`, () =>
      withTempDir(async (dir) => {
        const legacy = await openSqlite({
          stateDir: join(dir, "state"),
          logger: memoryLogger(),
          readMounts: localMounts,
        });
        try {
          legacy.exec(`create table "${table}" (note text) strict`);
        } finally {
          legacy.close();
        }

        const clock = new ManualClock();
        const error = await failure(openStateDatabase(options(dir, BASE, clock)));
        const name = `pre-v1-${backupStamp(clock.now())}.db`;
        expect(error).toBeInstanceOf(SchemaDriftError);
        expect((error as SchemaDriftError).backup).toBe(join(dir, "state", "backups", name));
        expect(backups(dir)).toEqual([name]);
      }));
  }

  it("applies steps in order, records each one and backs up first", () =>
    withTempDir(async (dir) => {
      const clock = new ManualClock();
      const first = await openStateDatabase(options(dir, BASE, clock));
      first.close();
      expect(backups(dir)).toEqual([]);

      clock.advance(60_000);
      const state = await openStateDatabase(options(dir, [...BASE, second, third], clock));
      try {
        const db = state.connection;
        expect(state.migration.from).toBe(1);
        expect(state.migration.to).toBe(3);
        expect(state.migration.backup).toBe(
          join(dir, "state", "backups", `pre-v3-${backupStamp(clock.now())}.db`),
        );
        expect(statSync(state.migration.backup ?? "").mode & 0o777).toBe(0o600);
        const steps: readonly Migration[] = [...BASE, second, third];
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
      const again = await openStateDatabase(options(dir, [...BASE, second, third], clock));
      again.close();
      expect(again.migration.backup).toBeNull();
      expect(backups(dir)).toHaveLength(1);
    }));

  it("rolls back a failing step and leaves user_version unchanged", () =>
    withTempDir(async (dir) => {
      (await openStateDatabase(options(dir, BASE))).close();
      const broken: Migration = {
        version: 2,
        name: "broken",
        sql: "create table half (office_id text primary key) strict; insert into nowhere values (1);",
      };
      const error = await failure(openStateDatabase(options(dir, [...BASE, broken])));
      expect(error).toBeInstanceOf(MigrationFailedError);
      expect((error as MigrationFailedError).backup).toContain("pre-v2-");
      expect((error as Error).message).toContain((error as MigrationFailedError).backup ?? "");

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

  it("names no backup when a step fails on a new empty database (DIPO-122)", () =>
    withTempDir(async (dir) => {
      const broken: Migration = {
        version: 1,
        name: "broken",
        sql: "insert into nowhere values (1);",
      };
      const error = await failure(openStateDatabase(options(dir, [broken])));
      expect(error).toBeInstanceOf(MigrationFailedError);
      expect((error as MigrationFailedError).backup).toBeNull();
      expect((error as Error).message).toContain("the database was new and empty");
      expect(backups(dir)).toEqual([]);
    }));

  it("refuses a database newer than the binary with 'upgrade dipo'", () =>
    withTempDir(async (dir) => {
      (await openStateDatabase(options(dir, [...BASE, second]))).close();
      const error = await failure(openStateDatabase(options(dir, BASE)));
      expect(error).toBeInstanceOf(DatabaseTooNewError);
      expect((error as Error).message).toContain("upgrade dipo");
    }));

  it("stops when a recorded checksum differs from the binary's step", () =>
    withTempDir(async (dir) => {
      (await openStateDatabase(options(dir, [...BASE, second]))).close();
      const edited: Migration = {
        ...second,
        sql: `${"sql" in second ? second.sql : ""} -- edited`,
      };
      const error = await failure(openStateDatabase(options(dir, [...BASE, edited])));
      expect(error).toBeInstanceOf(MigrationChecksumError);
      expect((error as MigrationChecksumError).version).toBe(2);
      expect(backups(dir)).toEqual([]);
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
        expect(await run([...BASE, third])).toBeInstanceOf(Error);
        expect(await run([second, ...BASE])).toBeInstanceOf(Error);
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

/**
 * A database an earlier dipo wrote before the squash: its first recorded step is the old
 * `offices and schema_migrations`, and `version` steps are recorded. Like the real one it is in WAL
 * mode and was closed cleanly: everything is in the main file, and no `-wal` or `-shm` is left.
 */
function writePreSquashDatabase(path: string, version: number): void {
  const db = new Database(path, { create: true });
  try {
    db.exec("pragma journal_mode = WAL");
    db.exec(`
create table schema_migrations (version integer primary key, name text not null,
  checksum text not null, engine_version text not null, applied_at integer not null) strict;
create table offices (office_id text primary key, path text not null, display_name text not null,
  added_at integer not null, forgotten_at integer, epoch text not null, next_seq integer not null,
  replay_floor_seq integer not null) strict;
create table context_packs (office_id text not null, branch text not null, primary key (office_id, branch)) strict;
`);
    const insert = db.query(
      "insert into schema_migrations values ($version, $name, 'c', '0.0.0-old', 0)",
    );
    for (let step = 1; step <= version; step++) {
      insert.run({ $version: step, $name: step === 1 ? PRE_SQUASH_FIRST_STEP : `step ${step}` });
    }
    db.exec(`pragma user_version = ${version}`);
    db.exec("pragma wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  // macOS's SQLite keeps both files after a close; the old dipo's clean stop removed them.
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

describe("the base schema", () => {
  it("builds every table the code reads in a fresh database, at the head version", () =>
    withTempDir(async (dir) => {
      const state = await openStateDatabase(options(dir, MIGRATIONS));
      try {
        const db = state.connection;
        expect(MIGRATIONS.map((step) => step.version)).toEqual([1, 2]);
        expect(db.get<{ user_version: number }>("pragma user_version")).toEqual({
          user_version: 2,
        });
        const tables = db
          .all<{ name: string; strict: number }>(
            "select name, strict from pragma_table_list where schema = 'main' and substr(name, 1, 7) <> 'sqlite_' order by name",
          )
          .map((table) => `${table.name}${table.strict === 1 ? "" : " (not strict)"}`);
        expect(tables).toEqual([
          "acceptance_tests",
          "agents",
          "backlog_config_previous",
          "backlog_journal",
          "backlog_mirror",
          "backlog_pr_blocks",
          "backlog_prs",
          "capability_confirmations",
          "capability_proposals",
          "catch_ups",
          "change_log",
          "claims",
          "compactions",
          "config_snapshots",
          "decision_notes",
          "done_elsewhere",
          "done_reports",
          "feedback_items",
          "gate_decisions",
          "gates",
          "ingest_cursors",
          "next_up_declines",
          "office_scan_marks",
          "offices",
          "once_notices",
          "output_chunks",
          "parks",
          "prompt_parts",
          "prompt_texts",
          "proposals",
          "questions",
          "released_branches",
          "report_sendbacks",
          "requests",
          "review_verdicts",
          "run_capabilities",
          "run_env_files",
          "run_extra_scripts",
          "run_grants",
          "run_intents",
          "run_outcomes",
          "run_profiles",
          "run_signals",
          "run_steps",
          "run_summaries",
          "runs",
          "scans",
          "schema_migrations",
          "starts_paused",
          "stories",
          "story_aliases",
          "story_prs",
          "usage_daily",
          "usage_messages",
          "usage_totals",
          "worker_hosts",
          "worker_notes",
        ]);
      } finally {
        state.close();
      }
    }));

  it("leaves out what no code reads: permission questions, the pause intent and the dead columns", () =>
    withTempDir(async (dir) => {
      const state = await openStateDatabase(options(dir, MIGRATIONS));
      try {
        const db = state.connection;
        const columns = (table: string) =>
          db
            .all<{ name: string }>("select name from pragma_table_info($table)", { table })
            .map((column) => column.name);
        expect(columns("agents")).not.toContain("system_hash");
        expect(columns("stories")).not.toContain("backlog_created");
        expect(columns("offices")).not.toContain("tui_left_at");
        for (const gone of ["tool", "input", "hook", "decision", "allow_used_at"]) {
          expect(columns("questions")).not.toContain(gone);
        }
        db.run(
          "insert into offices (office_id, path, display_name, added_at, next_seq) values ('o-1', '/r', 'r', 0, 1)",
        );
        db.run(
          `insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
             loop_cap, config_hash, started_at)
           values ('o-1', 'run-1', 'session', 'developer', 'm', 'tokens', 1, 1, 'h', 0)`,
        );
        const pause = () =>
          db.run(
            `insert into run_intents (office_id, run_id, intent_id, kind, detail, state, created_at)
             values ('o-1', 'run-1', 1, 'pause', '{}', 'pending', 0)`,
          );
        expect(pause).toThrow("CHECK constraint failed");
        const question = () =>
          db.run(
            `insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at)
             values ('o-1', 'qst-1', 'run-1', 'agt-1', 'permission', 'Bash(ls)', 0)`,
          );
        expect(question).toThrow("CHECK constraint failed");
      } finally {
        state.close();
      }
    }));
});

describe("a database from before the squash", () => {
  for (const version of [74, 1]) {
    it(`is refused at open with what happened and to start fresh, and left as it was (version ${version})`, () =>
      withTempDir(async (dir) => {
        const state = join(dir, "state");
        // openSqlite makes <state> with its modes; the old file is written into it.
        (
          await openSqlite({ stateDir: state, logger: memoryLogger(), readMounts: localMounts })
        ).close();
        const path = join(state, "dipo.db");
        writePreSquashDatabase(path, version);
        const before = readFileSync(path);
        const files = readdirSync(state).toSorted();

        const error = await failure(openStateDatabase(options(dir, MIGRATIONS)));
        expect(error).toBeInstanceOf(DatabaseBeforeSquashError);
        const message = (error as Error).message;
        expect(message).toContain(path);
        expect(message).toContain("written by an earlier dipo");
        expect(message).toContain("creates a fresh database");
        expect(message).toContain(`version ${version}`);
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path).equals(before)).toBe(true);
        // No -wal or -shm appears next to the refused file.
        expect(readdirSync(state).toSorted()).toEqual(files);
        expect(backups(dir)).toEqual([]);

        const shown = databaseFailure(error, state);
        expect(shown.details).toEqual({ reason: "beforeSquash" });
        expect(shown.text).toContain(path);
        expect(shown.text).toContain("dipo daemon stop");
        expect(shown.text).toContain("creates a fresh database");
      }));
  }

  it("is still named as one when only migrate sees it (the read-only look missed it)", () =>
    withTempDir(async (dir) => {
      const state = join(dir, "state");
      (
        await openSqlite({ stateDir: state, logger: memoryLogger(), readMounts: localMounts })
      ).close();
      writePreSquashDatabase(join(state, "dipo.db"), 74);
      const db = await openSqlite({
        stateDir: state,
        logger: memoryLogger(),
        readMounts: localMounts,
      });
      try {
        const error = await failure(
          migrate(db, {
            migrations: MIGRATIONS,
            clock: new ManualClock(),
            logger: memoryLogger(),
            engineVersion: ENGINE_VERSION,
          }),
        );
        expect(error).toBeInstanceOf(DatabaseBeforeSquashError);
        expect(error).not.toBeInstanceOf(DatabaseTooNewError);
      } finally {
        db.close();
      }
    }));

  it("is still told apart from a database a newer dipo wrote", () =>
    withTempDir(async (dir) => {
      (await openStateDatabase(options(dir, [...BASE, second]))).close();
      const error = await failure(openStateDatabase(options(dir, BASE)));
      expect(error).toBeInstanceOf(DatabaseTooNewError);
      expect(error).not.toBeInstanceOf(DatabaseBeforeSquashError);
    }));
});
