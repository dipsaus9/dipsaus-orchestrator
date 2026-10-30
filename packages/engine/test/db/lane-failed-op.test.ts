// Migration 72 (DIPO-401): `backlog_journal.state` allows `failed`, an operation the Backlog CLI
// failed on, closed so the others go on. A database at version 71 keeps its journal rows and its
// index, takes a `failed` row and still refuses an unknown state; a fresh and a migrated database
// have the same schema.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { localMounts, memoryLogger } from "./helpers";

const open = (dir: string, name: string, migrations?: readonly Migration[]) =>
  openStateDatabase({
    stateDir: join(dir, name),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock: new ManualClock(),
    engineVersion: "0.0.0-test",
    ...(migrations === undefined ? {} : { migrations }),
  });

type Db = { all<T>(sql: string): T[] };

/** Every table, index and trigger of the database, with its SQL, by name. */
function schema(db: Db): { type: string; name: string; sql: string | null }[] {
  return db.all<{ type: string; name: string; sql: string | null }>(
    `select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name`,
  );
}

const BEFORE = MIGRATIONS.filter((step) => step.version <= 71);

const INSERT = `insert into backlog_journal (office_id, op_id, key, subject, op_kind, target, state,
  created_at, updated_at) values ('off-1', $op, null, 'DIPO-300', 'propose', '{}', $state, 1, 1)`;

describe("migration 72 (DIPO-401)", () => {
  it("keeps the journal of a database at version 71 and lets an operation be failed", () =>
    withTempDir(async (dir) => {
      expect(BEFORE.at(-1)?.version).toBe(71);
      const old = await open(dir, "migrated", BEFORE);
      try {
        const db = old.connection;
        db.immediate(() => {
          db.exec(`insert into offices (office_id, path, display_name, added_at, next_seq)
            values ('off-1', '/repo', 'repo', 0, 1)`);
          db.run(INSERT, { op: 1, state: "pending" });
          db.run(INSERT, { op: 2, state: "dropped" });
        });
        expect(() => db.run(INSERT, { op: 3, state: "failed" })).toThrow();
      } finally {
        old.close();
      }

      const migrated = await open(dir, "migrated");
      try {
        const db = migrated.connection;
        expect(
          db.all<{ op_id: number; state: string }>(
            "select op_id, state from backlog_journal order by op_id",
          ),
        ).toEqual([
          { op_id: 1, state: "pending" },
          { op_id: 2, state: "dropped" },
        ]);
        db.run(INSERT, { op: 3, state: "failed" });
        expect(() => db.run(INSERT, { op: 4, state: "lost" })).toThrow();
        expect(
          db.all<{ name: string }>(
            "select name from sqlite_master where type = 'index' and tbl_name = 'backlog_journal'",
          ),
        ).toContainEqual({ name: "backlog_journal_open" });
      } finally {
        migrated.close();
      }
    }));

  it("gives a fresh and a migrated database the same schema", () =>
    withTempDir(async (dir) => {
      const old = await open(dir, "migrated", BEFORE);
      old.close();
      const migrated = await open(dir, "migrated");
      const fresh = await open(dir, "fresh");
      try {
        expect(schema(migrated.connection)).toEqual(schema(fresh.connection));
      } finally {
        migrated.close();
        fresh.close();
      }
    }));
});
