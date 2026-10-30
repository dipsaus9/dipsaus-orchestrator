// Migration 57 (DIPO-344): every stored park reason and cause maps to one of the eight reasons of
// 0001, the `cause` column and the question trigger of migration 50 go, and a fresh database has
// the same schema as a migrated one.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { KNOWN_PARK_REASONS } from "@dipsaus-orchestrator/contract";
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

function schema(db: Db): { type: string; name: string; sql: string | null }[] {
  return db.all<{ type: string; name: string; sql: string | null }>(
    `select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name`,
  );
}

/** Every reason and cause a park could be stored with before migration 57, and what it becomes. */
const CASES: readonly (readonly [reason: string, cause: string | null, mapped: string])[] = [
  ["ambiguous-spec", "question", "ambiguous-spec"],
  ["ambiguous-spec", "no-report", "worker-failed"],
  ["ambiguous-spec", "rule-conflict", "ambiguous-spec"],
  ["verify-failing", "loops", "verify-failing"],
  ["verify-failing", "ci", "verify-failing"],
  ["verify-failing", "refused", "verify-failing"],
  ["verify-failing", "capped", "budget-exceeded"],
  ["conflict", "merge-in-progress", "conflict"],
  ["conflict", "unwritable-path", "conflict"],
  ["conflict", "push-rejected", "conflict"],
  ["conflict", "slot-refused", "conflict"],
  ["conflict", "catch-up-failed", "conflict"],
  ["scope-violation", "paths", "scope-violation"],
  ["scope-violation", "tampered", "scope-violation"],
  ["scope-violation", "task-file", "scope-violation"],
  ["scope-violation", "protected-file", "scope-violation"],
  ["scope-violation", "secret", "scope-violation"],
  ["scope-violation", "part-refused", "scope-violation"],
  ["scope-violation", "backstop", "scope-violation"],
  ["scope-violation", "hand-change", "scope-violation"],
  ["review-blocked", "rounds", "review-blocked"],
  ["budget-exceeded", "build", "budget-exceeded"],
  ["budget-exceeded", "review", "budget-exceeded"],
  ["worker-failed", "build", "worker-failed"],
  ["worker-failed", "review", "worker-failed"],
  ["worker-failed", "review-cap", "worker-failed"],
  ["worker-failed", "stream-drift", "worker-failed"],
  ["stopped", "maintainer", "by-maintainer"],
  ["stopped", "review", "by-maintainer"],
  ["stopped", "pr-closed", "by-maintainer"],
  ["on-hold", null, "by-maintainer"],
  ["interrupted", "build", "worker-failed"],
  ["needs-permission", "build", "worker-failed"],
  ["needs-scope", null, "worker-failed"],
  ["something-else", null, "worker-failed"],
];

describe("migration 57 (DIPO-344)", () => {
  it("maps every old reason and cause to one of the eight reasons and drops the cause", () =>
    withTempDir(async (dir) => {
      const before = MIGRATIONS.filter((step) => step.version <= 56);
      expect(before.at(-1)?.version).toBe(56);
      const old = await open(dir, "migrated", before);
      try {
        const db = old.connection;
        db.immediate(() => {
          db.exec(`insert into offices (office_id, path, display_name, added_at, epoch, next_seq,
            replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);`);
          CASES.forEach(([reason, cause], index) => {
            db.run(
              `insert into parks (office_id, park_id, key, story_id, run_id, reason, cause,
                 from_state, detail, at)
               values ('off-1', $id, 'stk_1', 'DIPO-1', null, $reason, $cause, 'In Progress',
                 'detail', 0)`,
              { id: index + 1, reason, cause },
            );
          });
          db.exec(`insert into run_outcomes (office_id, run_id, role, model, outcome, park_reasons,
              loops, review_rounds, verify_failures, budget_tokens, minutes, ended_at)
            values ('off-1', 'run-1', 'developer', 'haiku', 'parked',
              '["stopped","interrupted","verify-failing","on-hold","needs-permission"]',
              0, 0, 0, 0, 0, 0),
              ('off-1', 'run-2', 'developer', 'haiku', 'parked', '["conflict"]', 0, 0, 0, 0, 0, 0);`);
        });
      } finally {
        old.close();
      }
      const migrated = await open(dir, "migrated");
      try {
        const db = migrated.connection;
        const rows = db.all<{ park_id: number; reason: string }>(
          "select park_id, reason from parks order by park_id",
        );
        expect(rows.map((row) => row.reason)).toEqual(CASES.map(([, , mapped]) => mapped));
        for (const row of rows) {
          expect(KNOWN_PARK_REASONS as readonly string[]).toContain(row.reason);
        }
        const columns = db
          .all<{ name: string }>("select name from pragma_table_info('parks')")
          .map((row) => row.name);
        expect(columns).not.toContain("cause");
        expect(
          db.all<{ run_id: string; park_reasons: string }>(
            "select run_id, park_reasons from run_outcomes order by run_id",
          ),
        ).toEqual([
          {
            run_id: "run-1",
            park_reasons:
              '["by-maintainer","worker-failed","verify-failing","by-maintainer","worker-failed"]',
          },
          { run_id: "run-2", park_reasons: '["conflict"]' },
        ]);
        expect(
          db.all("select name from sqlite_master where name = 'questions_expire_with_park'"),
        ).toEqual([]);
      } finally {
        migrated.close();
      }
    }));

  it("leaves a resolved park's questions to the engine: no trigger closes them", () =>
    withTempDir(async (dir) => {
      const state = await open(dir, "state");
      try {
        const db = state.connection;
        db.immediate(() =>
          db.exec(`insert into offices (office_id, path, display_name, added_at, next_seq)
              values ('off-1', '/repo', 'repo', 0, 1);
            insert into stories (office_id, key, story_id, provisional, first_seen_at)
              values ('off-1', 'stk_1', 'DIPO-1', 0, 0);
            insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
              loop_cap, config_hash, started_at)
              values ('off-1', 'run-1', 'session', 'developer', 'haiku', 'tokens', 1, 3, 'h', 0);
            insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, at)
              values ('off-1', 1, 'stk_1', 'DIPO-1', 'run-1', 'ambiguous-spec', 'Which?', 1);
            insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at,
              park_id) values ('off-1', 'qst-1', 'run-1', 'agt-1', 'question', 'Which?', 1, 1);
            update parks set resolved_at = 5, resolved_how = 'drop' where park_id = 1;`),
        );
        expect(db.all("select question_id, closed_at from questions")).toEqual([
          { question_id: "qst-1", closed_at: null },
        ]);
      } finally {
        state.close();
      }
    }));

  it("gives a fresh and a migrated database the same schema", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        "migrated",
        MIGRATIONS.filter((step) => step.version <= 56),
      );
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
