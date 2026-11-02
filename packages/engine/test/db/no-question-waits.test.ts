// Migration 73 (DIPO-428): `questions.wait_until` goes, since a worker's question parks at once
// (0020). A database at version 72 keeps its questions and their parks; a fresh and a migrated
// database have the same schema.

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

function columns(db: Db): string[] {
  return db
    .all<{ name: string }>("select name from pragma_table_info('questions')")
    .map((column) => column.name);
}

const BEFORE = MIGRATIONS.filter((step) => step.version <= 72);

const ROWS = `insert into offices (office_id, path, display_name, added_at, next_seq)
    values ('off-1', '/repo', 'repo', 0, 1);
  insert into stories (office_id, key, story_id, provisional, first_seen_at)
    values ('off-1', 'stk_1', 'DIPO-1', 0, 0);
  insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit, loop_cap,
    config_hash, started_at)
    values ('off-1', 'run-1', 'session', 'developer', 'haiku', 'tokens', 1, 3, 'h', 0);
  insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, at)
    values ('off-1', 1, 'stk_1', 'DIPO-1', 'run-1', 'ambiguous-spec', 'Which?', 1);
  insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at, park_id)
    values ('off-1', 'qst-1', 'run-1', 'agt-1', 'question', 'Which?', 1, 1);
  insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at,
    wait_until)
    values ('off-1', 'qst-2', 'run-1', 'agt-1', 'question', 'Live?', 1, 900001);`;

describe("migration 73 (DIPO-428)", () => {
  it("drops questions.wait_until and keeps the questions of a database at version 72", () =>
    withTempDir(async (dir) => {
      expect(BEFORE.at(-1)?.version).toBe(72);
      const old = await open(dir, "migrated", BEFORE);
      try {
        old.connection.immediate(() => old.connection.exec(ROWS));
        expect(columns(old.connection)).toContain("wait_until");
      } finally {
        old.close();
      }

      const migrated = await open(dir, "migrated");
      try {
        const db = migrated.connection;
        expect(columns(db)).not.toContain("wait_until");
        expect(
          db.all("select question_id, park_id, closed_at from questions order by question_id"),
        ).toEqual([
          { question_id: "qst-1", park_id: 1, closed_at: null },
          { question_id: "qst-2", park_id: null, closed_at: null },
        ]);
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
