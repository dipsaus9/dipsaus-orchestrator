// Migration 74 (DIPO-432): `questions.delivered` holds `on-resume` or null, never `now` (0020). A
// database at version 73 keeps every question and its columns, a stored `now` reads back as
// `on-resume`, the indexes and the foreign key to `runs` stay, and a fresh and a migrated database
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

type Db = {
  all<T>(sql: string): T[];
  run(sql: string, params?: Record<string, unknown>): unknown;
};

/** Every table and index of the database, with its SQL, by name. */
function schema(db: Db): { type: string; name: string; sql: string | null }[] {
  return db.all<{ type: string; name: string; sql: string | null }>(
    `select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name`,
  );
}

const BEFORE = MIGRATIONS.filter((step) => step.version <= 73);

const PARENTS = `insert into offices (office_id, path, display_name, added_at, next_seq)
    values ('off-1', '/repo', 'repo', 0, 1);
  insert into stories (office_id, key, story_id, provisional, first_seen_at)
    values ('off-1', 'stk_1', 'DIPO-1', 0, 0);
  insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit, loop_cap,
    config_hash, started_at)
    values ('off-1', 'run-1', 'session', 'developer', 'haiku', 'tokens', 1, 3, 'h', 0);
  insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, at)
    values ('off-1', 1, 'stk_1', 'DIPO-1', 'run-1', 'ambiguous-spec', 'Which?', 1);`;

const FIXTURE = `${PARENTS}
  insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at, park_id,
    delivered, answer, answered_at, closed_at, closed_how)
    values ('off-1', 'qst-now', 'run-1', 'agt-1', 'question', 'Which?', 1, 1,
      'now', 'the first', 5, 6, 'answered');
  insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at, park_id,
    delivered, answer, answered_at, closed_at, closed_how)
    values ('off-1', 'qst-resume', 'run-1', 'agt-1', 'question', 'Which?', 1, 1,
      'on-resume', 'the second', 5, 6, 'answered');
  insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at, park_id)
    values ('off-1', 'qst-open', 'run-1', 'agt-1', 'question', 'Still?', 2, 1);
  insert into questions (office_id, question_id, run_id, agent_id, kind, text, tool, input,
    asked_at, decision, allow_used_at, park_id, closed_at, closed_how)
    values ('off-1', 'qst-allow', 'run-1', 'agt-1', 'permission', 'Bash(ls)', 'Bash', 'ls',
      3, 'allow', 7, 1, 8, 'answered');`;

const COLUMNS = [
  "office_id",
  "question_id",
  "run_id",
  "agent_id",
  "kind",
  "text",
  "tool",
  "input",
  "hook",
  "asked_at",
  "answer",
  "decision",
  "answered_at",
  "delivered",
  "closed_at",
  "closed_how",
  "park_id",
  "allow_used_at",
];

describe("migration 74 (DIPO-432)", () => {
  it("keeps every question and reads a stored now back as on-resume", () =>
    withTempDir(async (dir) => {
      const old = await open(dir, "migrated", BEFORE);
      try {
        old.connection.immediate(() => old.connection.exec(FIXTURE));
      } finally {
        old.close();
      }

      const migrated = await open(dir, "migrated");
      try {
        const db = migrated.connection;
        expect(
          db
            .all<{ name: string }>("select name from pragma_table_info('questions')")
            .map((column) => column.name),
        ).toEqual(COLUMNS);
        expect(
          db.all(
            `select question_id, delivered, answer, closed_how, park_id, allow_used_at
             from questions order by question_id`,
          ),
        ).toEqual([
          {
            question_id: "qst-allow",
            delivered: null,
            answer: null,
            closed_how: "answered",
            park_id: 1,
            allow_used_at: 7,
          },
          {
            question_id: "qst-now",
            delivered: "on-resume",
            answer: "the first",
            closed_how: "answered",
            park_id: 1,
            allow_used_at: null,
          },
          {
            question_id: "qst-open",
            delivered: null,
            answer: null,
            closed_how: null,
            park_id: 1,
            allow_used_at: null,
          },
          {
            question_id: "qst-resume",
            delivered: "on-resume",
            answer: "the second",
            closed_how: "answered",
            park_id: 1,
            allow_used_at: null,
          },
        ]);
      } finally {
        migrated.close();
      }
    }));

  it("refuses now in the delivered column", () =>
    withTempDir(async (dir) => {
      const state = await open(dir, "fresh");
      try {
        const db = state.connection;
        db.immediate(() => db.exec(PARENTS));
        expect(() =>
          db.run(
            `insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at, delivered)
             values ('off-1', 'qst-x', 'run-1', 'agt-1', 'question', 'x', 1, 'now')`,
          ),
        ).toThrow();
        db.immediate(() =>
          db.exec(`insert into questions (office_id, question_id, run_id, agent_id, kind, text,
              asked_at, delivered)
            values ('off-1', 'qst-ok', 'run-1', 'agt-1', 'question', 'ok', 1, 'on-resume')`),
        );
        expect(db.all("select question_id, delivered from questions")).toEqual([
          { question_id: "qst-ok", delivered: "on-resume" },
        ]);
      } finally {
        state.close();
      }
    }));

  it("keeps the indexes and the foreign key to runs", () =>
    withTempDir(async (dir) => {
      const state = await open(dir, "fresh");
      try {
        const db = state.connection;
        expect(
          db.all<{ name: string; sql: string }>(
            "select name, sql from sqlite_schema where type = 'index' and tbl_name = 'questions' and name not like 'sqlite_%' order by name",
          ),
        ).toEqual([
          {
            name: "questions_allow_once",
            sql: "CREATE INDEX questions_allow_once on questions (office_id, run_id)\n  where park_id is not null and decision = 'allow' and allow_used_at is null",
          },
          {
            name: "questions_open",
            sql: "CREATE INDEX questions_open on questions (office_id, run_id) where closed_at is null",
          },
        ]);
        expect(
          db.all<{ table: string; from: string; to: string }>(
            'select "table", "from", "to" from pragma_foreign_key_list(\'questions\') order by id, seq',
          ),
        ).toEqual([
          { table: "runs", from: "office_id", to: "office_id" },
          { table: "runs", from: "run_id", to: "run_id" },
        ]);
      } finally {
        state.close();
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
