// Migration 34 (DIPO-142): `parks.cause`, the place wait of `runs`, the run step kinds of the
// review loop and the final `run_outcomes` columns.

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

describe("migration 34 on a database at version 33", () => {
  it("keeps every runs, run_steps, parks and run_outcomes row and gives the new columns their defaults", () =>
    withTempDir(async (dir) => {
      const before = MIGRATIONS.filter((step) => step.version <= 33);
      expect(before.at(-1)?.version).toBe(33);
      const old = await open(dir, before);
      try {
        const db = old.connection;
        expect(db.get<{ user_version: number }>("pragma user_version")?.user_version).toBe(33);
        db.immediate(() => {
          db.exec(`
            insert into offices (office_id, path, display_name, added_at, epoch, next_seq,
              replay_floor_seq)
              values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into runs (office_id, run_id, kind, key, story_id, tier, role, model,
              start_sha, branch, worktree, slot, budget_unit, budget_limit, loop_cap,
              review_round_cap, config_hash, started_at, ended_at, end_kind, parked_ms,
              max_turns, max_minutes)
              values ('off-1', 'run-story', 'story', 'DIPO-7', 'DIPO-7', 'M', 'developer',
                'sonnet', 'abc123', 'DIPO-7/thing', '/wt/DIPO-7', 1, 'tokens', 500000, 4, 3,
                'cfg-1', 1000, 9000, 'parked', 1200, 80, 45);
            insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
              loop_cap, config_hash, started_at)
              values ('off-1', 'run-session', 'session', 'planner', 'opus', 'usd', 5, 1,
                'cfg-1', 2000);
            insert into run_steps (office_id, run_id, step, kind, value, at) values
              ('off-1', 'run-story', 1, 'phase', 'implement', 1100),
              ('off-1', 'run-story', 2, 'loop', '1', 1200),
              ('off-1', 'run-story', 3, 'review', 'blocked', 1300),
              ('off-1', 'run-story', 4, 'loop', '2', 1400),
              ('off-1', 'run-session', 1, 'phase', 'plan', 2100);
            insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state,
              detail, last_good_commit, at, resolved_at, resolved_how)
              values
              ('off-1', 1, 'DIPO-7', 'DIPO-7', 'run-story', 'loop-cap', 'In Progress',
                'loop cap 4 reached', 'def456', 5000, 6000, 'resume'),
              ('off-1', 2, 'DIPO-7', 'DIPO-7', 'run-story', 'budget', 'In Progress',
                'token budget spent', null, 9000, null, null);
            insert into run_outcomes (office_id, run_id, story_id, tier, role, model, outcome,
              park_reasons, loops, review_rounds, verify_failures, budget_tokens, minutes,
              criteria_count, scope_size, ended_at)
              values ('off-1', 'run-story', 'DIPO-7', 'M', 'developer', 'sonnet', 'parked',
                '["budget"]', 2, 1, 1, 480000, 12.5, 5, 9, 9000);
          `);
        });
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        const db = state.connection;
        expect(db.get<{ user_version: number }>("pragma user_version")?.user_version).toBe(34);
        expect(
          db.all(
            `select office_id, run_id, step, kind, value, at from run_steps
              order by run_id, step`,
          ),
        ).toEqual([
          {
            office_id: "off-1",
            run_id: "run-session",
            step: 1,
            kind: "phase",
            value: "plan",
            at: 2100,
          },
          {
            office_id: "off-1",
            run_id: "run-story",
            step: 1,
            kind: "phase",
            value: "implement",
            at: 1100,
          },
          { office_id: "off-1", run_id: "run-story", step: 2, kind: "loop", value: "1", at: 1200 },
          {
            office_id: "off-1",
            run_id: "run-story",
            step: 3,
            kind: "review",
            value: "blocked",
            at: 1300,
          },
          { office_id: "off-1", run_id: "run-story", step: 4, kind: "loop", value: "2", at: 1400 },
        ]);
        expect(
          db.all(
            `select run_id, kind, key, story_id, tier, role, model, start_sha, branch, worktree,
               slot, budget_unit, budget_limit, loop_cap, review_round_cap, config_hash,
               started_at, ended_at, end_kind, parked_ms, max_turns, max_minutes, waiting,
               waiting_since
             from runs order by run_id`,
          ),
        ).toEqual([
          {
            run_id: "run-session",
            kind: "session",
            key: null,
            story_id: null,
            tier: null,
            role: "planner",
            model: "opus",
            start_sha: null,
            branch: null,
            worktree: null,
            slot: null,
            budget_unit: "usd",
            budget_limit: 5,
            loop_cap: 1,
            review_round_cap: null,
            config_hash: "cfg-1",
            started_at: 2000,
            ended_at: null,
            end_kind: null,
            parked_ms: 0,
            max_turns: null,
            max_minutes: null,
            waiting: null,
            waiting_since: null,
          },
          {
            run_id: "run-story",
            kind: "story",
            key: "DIPO-7",
            story_id: "DIPO-7",
            tier: "M",
            role: "developer",
            model: "sonnet",
            start_sha: "abc123",
            branch: "DIPO-7/thing",
            worktree: "/wt/DIPO-7",
            slot: 1,
            budget_unit: "tokens",
            budget_limit: 500000,
            loop_cap: 4,
            review_round_cap: 3,
            config_hash: "cfg-1",
            started_at: 1000,
            ended_at: 9000,
            end_kind: "parked",
            parked_ms: 1200,
            max_turns: 80,
            max_minutes: 45,
            waiting: null,
            waiting_since: null,
          },
        ]);
        expect(
          db.all(
            `select park_id, key, story_id, run_id, reason, from_state, detail,
               last_good_commit, at, resolved_at, resolved_how, cause
             from parks order by park_id`,
          ),
        ).toEqual([
          {
            park_id: 1,
            key: "DIPO-7",
            story_id: "DIPO-7",
            run_id: "run-story",
            reason: "loop-cap",
            from_state: "In Progress",
            detail: "loop cap 4 reached",
            last_good_commit: "def456",
            at: 5000,
            resolved_at: 6000,
            resolved_how: "resume",
            cause: null,
          },
          {
            park_id: 2,
            key: "DIPO-7",
            story_id: "DIPO-7",
            run_id: "run-story",
            reason: "budget",
            from_state: "In Progress",
            detail: "token budget spent",
            last_good_commit: null,
            at: 9000,
            resolved_at: null,
            resolved_how: null,
            cause: null,
          },
        ]);
        expect(
          db.all(
            `select run_id, story_id, tier, role, model, outcome, park_reasons, loops,
               review_rounds, verify_failures, budget_tokens, minutes, criteria_count,
               scope_size, ended_at, end_kind, final, review_rounds_failed, ci_attempts,
               conflict_handoffs, override
             from run_outcomes`,
          ),
        ).toEqual([
          {
            run_id: "run-story",
            story_id: "DIPO-7",
            tier: "M",
            role: "developer",
            model: "sonnet",
            outcome: "parked",
            park_reasons: '["budget"]',
            loops: 2,
            review_rounds: 1,
            verify_failures: 1,
            budget_tokens: 480000,
            minutes: 12.5,
            criteria_count: 5,
            scope_size: 9,
            ended_at: 9000,
            end_kind: null,
            final: 0,
            review_rounds_failed: 0,
            ci_attempts: 0,
            conflict_handoffs: 0,
            override: 0,
          },
        ]);
      } finally {
        state.close();
      }
    }));
});

describe("migration 34: run rounds, places and park causes", () => {
  it("is registered as version 34 and adds parks.cause, the place wait and the outcome columns", () =>
    withTempDir(async (dir) => {
      expect(MIGRATIONS.find((migration) => migration.version === 34)?.name).toBe(
        "run rounds, places and park causes",
      );
      const state = await open(dir);
      try {
        const columns = (table: string) =>
          state.connection
            .all<{ name: string }>(`select name from pragma_table_info('${table}')`)
            .map((row) => row.name);
        expect(columns("parks")).toContain("cause");
        expect(columns("runs")).toEqual(expect.arrayContaining(["waiting", "waiting_since"]));
        expect(columns("run_outcomes")).toEqual(
          expect.arrayContaining([
            "end_kind",
            "final",
            "loops",
            "review_rounds",
            "review_rounds_failed",
            "ci_attempts",
            "conflict_handoffs",
            "override",
          ]),
        );
        expect(columns("run_steps")).toEqual([
          "office_id",
          "run_id",
          "step",
          "kind",
          "value",
          "at",
        ]);
      } finally {
        state.close();
      }
    }));

  it("lets run_steps hold the review loop's kinds and nothing else", () =>
    withTempDir(async (dir) => {
      const state = await open(dir);
      const db = state.connection;
      try {
        db.immediate(() => {
          db.exec(`
            insert into offices (office_id, path, display_name, added_at, epoch, next_seq,
              replay_floor_seq)
              values ('off_1', '/x', 'x', 0, 'e', 1, 0);
            insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
              loop_cap, config_hash, started_at)
              values ('off_1', 'run_1', 'session', 'developer', 'haiku', 'tokens', 1, 1, 'h', 0);
          `);
          let step = 0;
          for (const kind of [
            "phase",
            "loop",
            "review",
            "review-failed",
            "ci",
            "conflict",
            "override",
          ]) {
            step += 1;
            db.run(
              `insert into run_steps (office_id, run_id, step, kind, value, at)
                values ('off_1', 'run_1', $step, $kind, 'x', 0)`,
              { step, kind },
            );
          }
        });
        expect(() =>
          db.immediate(() =>
            db.run(
              `insert into run_steps (office_id, run_id, step, kind, value, at)
                values ('off_1', 'run_1', 99, 'merge', 'x', 0)`,
            ),
          ),
        ).toThrow();
      } finally {
        state.close();
      }
    }));
});
