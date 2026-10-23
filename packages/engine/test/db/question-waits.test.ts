// Migration 48 (DIPO-159): `questions.wait_until`, the end of a worker question's live wait, and
// the trigger that expires the questions a park carried once that park is resolved in any way. The
// wait and the park's questions in use are tested in test/hooks/worker-questions.test.ts.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { localMounts, memoryLogger } from "./helpers";

const open = (dir: string, migrations?: readonly Migration[]) =>
  openStateDatabase({
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock: new ManualClock(),
    engineVersion: "0.0.0-test",
    ...(migrations === undefined ? {} : { migrations }),
  });

const ROWS = `insert into offices (office_id, path, display_name, added_at, epoch, next_seq,
    replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
  insert into stories (office_id, key, story_id, provisional, first_seen_at)
    values ('off-1', 'stk_1', 'DIPO-1', 0, 0);
  insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit, loop_cap,
    config_hash, started_at)
    values ('off-1', 'run-1', 'session', 'developer', 'haiku', 'tokens', 1, 3, 'h', 0);
  insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state, detail, at)
    values ('off-1', 1, 'stk_1', 'DIPO-1', 'run-1', 'ambiguous-spec', 'In Progress', 'Which?', 1);
  insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at, park_id)
    values ('off-1', 'qst-1', 'run-1', 'agt-1', 'question', 'Which?', 1, 1);
  insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at, park_id,
    closed_at, closed_how, answer)
    values ('off-1', 'qst-2', 'run-1', 'agt-1', 'question', 'Which?', 1, 1, 2, 'answered', 'This');
  insert into questions (office_id, question_id, run_id, agent_id, kind, text, asked_at)
    values ('off-1', 'qst-3', 'run-1', 'agt-1', 'question', 'Other?', 1);`;

describe("migration 48 on a database at version 47", () => {
  it("adds questions.wait_until and expires a resolved park's open questions only", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 47),
      );
      try {
        const columns = old.connection
          .all<{ name: string }>("select name from pragma_table_info('questions')")
          .map((row) => row.name);
        expect(columns).not.toContain("wait_until");
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        const db = state.connection;
        expect(MIGRATIONS.find((step) => step.version === 48)?.name).toBe("question waits");
        db.immediate(() => db.exec(ROWS));
        expect(
          db.all("select question_id, wait_until from questions order by question_id"),
        ).toEqual([
          { question_id: "qst-1", wait_until: null },
          { question_id: "qst-2", wait_until: null },
          { question_id: "qst-3", wait_until: null },
        ]);
        db.immediate(() =>
          db.exec("update parks set resolved_at = 5, resolved_how = 'drop' where park_id = 1"),
        );
        expect(
          db.all("select question_id, closed_at, closed_how from questions order by question_id"),
        ).toEqual([
          { question_id: "qst-1", closed_at: 5, closed_how: "expired" },
          { question_id: "qst-2", closed_at: 2, closed_how: "answered" },
          { question_id: "qst-3", closed_at: null, closed_how: null },
        ]);
      } finally {
        state.close();
      }
    }));
});
