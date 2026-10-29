// Migration 67 (DIPO-373): a run ends done, parked or dropped, and a run at In Review stays open in
// phase review, test or merge. A database at version 66 with rows of every old end kind is
// migrated: each run takes one of the three endings (or none, open at In Review), a run open at In
// Review takes the phase it waits in, the outcome rows say the ending and lose `end_kind`, and a
// fresh database and the migrated one have the same schema.

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

const BEFORE = MIGRATIONS.filter((step) => step.version <= 66);

/**
 * A story run `id` of story `key` with the old end kind `kind` (null: still active), ended at 100.
 */
const storyRun = (id: string, key: string, kind: string | null): string =>
  `('off-1', '${id}', 'story', '${key}', '${key}', 'developer', 'm', 'a', '${key}/x', 'tokens',
    1, 3, 'h', 0, ${kind === null ? "null" : "100"}, ${kind === null ? "null" : `'${kind}'`})`;

/** The claim of run `id`: live when `released` is null, else released with that reason. */
const claim = (id: string, key: string, released: string | null): string =>
  `('off-1', '${id}', '${key}', '${key}', '${key}/x', 'main', 'b', 'a', 0, 0,
    ${released === null ? "null" : "100"}, ${released === null ? "null" : `'${released}'`})`;

/** Every old end kind (0067's file comment), each on its own run. */
const RUNS: readonly (readonly [string, string, string | null, string | null])[] = [
  // run, story, end kind, claim release (null: live)
  ["r-done", "S-1", "done", "done"],
  ["r-in-review", "S-2", "in-review", null],
  ["r-approved", "S-3", "reviewed", null],
  ["r-blocked", "S-4", "reviewed", null],
  ["r-override", "S-5", "reviewed", null],
  ["r-in-review-parked", "S-6", "in-review", null],
  ["r-discarded", "S-7", "in-review", "discard"],
  ["r-start-failed", "S-8", "start-failed", "start-failed"],
  ["r-capped", "S-9", "capped", null],
  ["r-reconciled-done", "S-10", "reconciled", null],
  ["r-reconciled-ready", "S-11", "reconciled", null],
  ["r-done-elsewhere", "S-12", "stopped", "done-elsewhere"],
  ["r-dropped", "S-13", "stopped", "drop"],
  ["r-active", "S-14", null, null],
  ["r-no-claim", "S-15", "in-review", null],
  ["r-reviewed-no-phase", "S-16", "reviewed", null],
];

const ROWS = `
insert into offices (office_id, path, display_name, added_at, epoch, next_seq, replay_floor_seq)
  values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
insert into runs (office_id, run_id, kind, key, story_id, role, model, start_sha, branch,
  budget_unit, budget_limit, loop_cap, config_hash, started_at, ended_at, end_kind)
  values ${RUNS.map(([id, key, kind]) => storyRun(id, key, kind)).join(",\n  ")};
insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit, loop_cap,
  config_hash, started_at, ended_at, end_kind)
  values
  ('off-1', 'q-answered', 'session', 'scan', 'm', 'tokens', 1, 3, 'h', 0, 100, 'answered'),
  ('off-1', 'q-lost', 'session', 'scan', 'm', 'tokens', 1, 3, 'h', 0, 100, 'lost'),
  ('off-1', 'q-failed', 'session', 'scan', 'm', 'tokens', 1, 3, 'h', 0, 100, 'failed');
insert into claims (office_id, run_id, key, story_id, branch, base, base_sha, start_sha, reused,
  claimed_at, released_at, release_reason)
  values ${RUNS.filter(([id]) => id !== "r-no-claim")
    .map(([id, key, , released]) => claim(id, key, released))
    .join(",\n  ")};
insert into run_steps (office_id, run_id, step, kind, value, at)
  values
  ('off-1', 'r-in-review', 1, 'phase', 'build', 10),
  ('off-1', 'r-approved', 1, 'phase', 'review', 50),
  ('off-1', 'r-blocked', 1, 'phase', 'review', 50),
  ('off-1', 'r-override', 1, 'phase', 'review', 50),
  ('off-1', 'r-in-review-parked', 1, 'phase', 'build', 10),
  ('off-1', 'r-discarded', 1, 'phase', 'build', 10);
insert into review_verdicts (office_id, gate_id, run_id, key, round, model, commit_sha,
  code_tree_key, verdict, criteria, findings, summary, validation_notes, override_note,
  override_at, decided_at)
  values
  ('off-1', 'g-1', 'r-approved', 'S-3', 1, 'm', 'c', 't', 'blocked', '[]', '[]', '', '[]', null,
    null, 60),
  ('off-1', 'g-2', 'r-approved', 'S-3', 2, 'm', 'c', 't', 'approved', '[]', '[]', '', '[]', null,
    null, 70),
  ('off-1', 'g-3', 'r-blocked', 'S-4', 1, 'm', 'c', 't', 'blocked', '[]', '[]', '', '[]', null,
    null, 60),
  ('off-1', 'g-4', 'r-override', 'S-5', 1, 'm', 'c', 't', 'blocked', '[]', '[]', '', '[]',
    'merge it', 80, 60);
insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, at, resolved_at,
  resolved_how)
  values
  ('off-1', 1, 'S-6', 'S-6', 'r-in-review-parked', 'by-maintainer', 'later', 120, null, null),
  ('off-1', 2, 'S-9', 'S-9', 'r-capped', 'budget-exceeded', 'turn cap', 100, null, null),
  ('off-1', 3, 'S-12', 'S-12', 'r-done-elsewhere', 'by-maintainer', 'x', 90, 100,
    'done-elsewhere');
insert into stories (office_id, key, story_id, provisional, first_seen_at)
  values ('off-1', 'S-10', 'S-10', 0, 0), ('off-1', 'S-11', 'S-11', 0, 0);
insert into backlog_mirror (office_id, key, content_hash, kind, status, title, labels, read_at,
  source)
  values
  ('off-1', 'S-10', 'h', 'task', 'Done', 't', '[]', 0, 'base'),
  ('off-1', 'S-11', 'h', 'task', 'Ready', 't', '[]', 0, 'base');
insert into run_outcomes (office_id, run_id, role, model, outcome, park_reasons, loops,
  review_rounds, verify_failures, budget_tokens, minutes, ended_at, end_kind, final)
  values
  ('off-1', 'r-done', 'developer', 'm', 'done', '[]', 0, 0, 0, 0, 1, 100, 'done', 1),
  ('off-1', 'r-in-review', 'developer', 'm', 'in-review', '[]', 0, 0, 0, 0, 1, 100, 'in-review', 0),
  ('off-1', 'r-approved', 'developer', 'm', 'reviewed', '[]', 0, 0, 0, 0, 1, 100, 'reviewed', 0),
  ('off-1', 'r-in-review-parked', 'developer', 'm', 'in-review', '[]', 0, 0, 0, 0, 1, 100,
    'in-review', 0),
  ('off-1', 'r-discarded', 'developer', 'm', 'in-review', '[]', 0, 0, 0, 0, 1, 100, 'in-review', 0),
  ('off-1', 'r-start-failed', 'developer', 'm', 'start-failed', '[]', 0, 0, 0, 0, 1, 100,
    'start-failed', 0),
  ('off-1', 'r-capped', 'developer', 'm', 'parked', '["budget-exceeded"]', 0, 0, 0, 0, 1, 100,
    'capped', 0),
  ('off-1', 'r-reconciled-done', 'developer', 'm', 'reconciled', '[]', 0, 0, 0, 0, 1, 100,
    'reconciled', 0),
  ('off-1', 'r-done-elsewhere', 'developer', 'm', 'parked', '["by-maintainer"]', 0, 0, 0, 0, 1,
    100, 'stopped', 0),
  ('off-1', 'q-answered', 'scan', 'm', 'answered', '[]', 0, 0, 0, 0, 1, 100, 'answered', 0),
  ('off-1', 'q-lost', 'scan', 'm', 'lost', '[]', 0, 0, 0, 0, 1, 100, 'lost', 0),
  ('off-1', 'gone-in-review', 'developer', 'm', 'in-review', '[]', 0, 0, 0, 0, 1, 100,
    'in-review', 0),
  ('off-1', 'gone-reconciled', 'developer', 'm', 'reconciled', '[]', 0, 0, 0, 0, 1, 100,
    'reconciled', 0),
  ('off-1', 'gone-parked', 'developer', 'm', 'parked', '["conflict"]', 0, 0, 0, 0, 1, 100,
    'conflict', 0);
`;

async function migrated(dir: string) {
  const old = await open(dir, "migrated", BEFORE);
  try {
    expect(old.connection.get<{ user_version: number }>("pragma user_version")?.user_version).toBe(
      66,
    );
    old.connection.immediate(() => old.connection.exec(ROWS));
  } finally {
    old.close();
  }
  return open(dir, "migrated");
}

describe("migration 67 (DIPO-373)", () => {
  it("is registered as version 67", () => {
    expect(MIGRATIONS.find((step) => step.version === 67)?.name).toBe("three run endings");
  });

  it("ends every run done, parked or dropped, or leaves it open at In Review", () =>
    withTempDir(async (dir) => {
      const db = await migrated(dir);
      try {
        const runs = db.connection.all<{
          run_id: string;
          ended_at: number | null;
          end_kind: string | null;
        }>("select run_id, ended_at, end_kind from runs order by run_id");
        expect(Object.fromEntries(runs.map((run) => [run.run_id, run.end_kind]))).toEqual({
          "q-answered": "done",
          "q-failed": "dropped",
          "q-lost": "dropped",
          "r-active": null,
          "r-approved": null,
          "r-blocked": null,
          "r-capped": "parked",
          "r-discarded": "dropped",
          "r-done": "done",
          "r-done-elsewhere": "done",
          "r-dropped": "dropped",
          "r-in-review": null,
          "r-in-review-parked": "parked",
          // No claim row: nothing would ever end it.
          "r-no-claim": "dropped",
          "r-override": null,
          "r-reconciled-done": "done",
          "r-reconciled-ready": "dropped",
          "r-reviewed-no-phase": null,
          "r-start-failed": "dropped",
        });
        for (const run of runs) {
          if (run.end_kind !== null) expect(["done", "parked", "dropped"]).toContain(run.end_kind);
        }
        // A run open at In Review keeps the end of its last active period.
        const ended = (id: string) => runs.find((run) => run.run_id === id)?.ended_at;
        expect(ended("r-in-review")).toBe(100);
        expect(ended("r-approved")).toBe(100);
        expect(ended("r-active")).toBeNull();
      } finally {
        db.close();
      }
    }));

  it("puts each run at In Review with a live claim in the phase it waits in", () =>
    withTempDir(async (dir) => {
      const db = await migrated(dir);
      try {
        const phases = db.connection.all<{ run_id: string; value: string; at: number }>(
          `select run_id, value, at from run_steps s where kind = 'phase' and step = (
             select max(step) from run_steps t where t.office_id = s.office_id
               and t.run_id = s.run_id and t.kind = 'phase')
           order by run_id`,
        );
        expect(phases).toEqual(
          [
            // Released before the migration: its phase stays.
            { run_id: "r-discarded", value: "build", at: 10 },
            // The latest verdict is approved: past its review, waiting for its merge.
            { run_id: "r-approved", value: "merge", at: 100 },
            // A blocked verdict waits for its fix round.
            { run_id: "r-blocked", value: "build", at: 100 },
            // Waiting for its review.
            { run_id: "r-in-review", value: "review", at: 100 },
            // Parked while it waited for its review: a resume with no session lifts it there.
            { run_id: "r-in-review-parked", value: "review", at: 100 },
            // An overridden blocked verdict merges.
            { run_id: "r-override", value: "merge", at: 100 },
            // Past its review with no phase step and no verdict: waiting for its merge.
            { run_id: "r-reviewed-no-phase", value: "merge", at: 100 },
          ].toSorted((a, b) => a.run_id.localeCompare(b.run_id)),
        );
      } finally {
        db.close();
      }
    }));

  it("keeps one outcome row per ended run with its ending, final when done, without end_kind", () =>
    withTempDir(async (dir) => {
      const db = await migrated(dir);
      try {
        const rows = db.connection.all<{
          run_id: string;
          outcome: string;
          final: number;
          park_reasons: string;
        }>("select run_id, outcome, final, park_reasons from run_outcomes order by run_id");
        expect(rows).toEqual([
          { run_id: "gone-in-review", outcome: "dropped", final: 0, park_reasons: "[]" },
          { run_id: "gone-parked", outcome: "parked", final: 0, park_reasons: '["conflict"]' },
          { run_id: "gone-reconciled", outcome: "done", final: 1, park_reasons: "[]" },
          { run_id: "q-answered", outcome: "done", final: 1, park_reasons: "[]" },
          { run_id: "q-lost", outcome: "dropped", final: 0, park_reasons: "[]" },
          { run_id: "r-capped", outcome: "parked", final: 0, park_reasons: '["budget-exceeded"]' },
          { run_id: "r-discarded", outcome: "dropped", final: 0, park_reasons: "[]" },
          { run_id: "r-done", outcome: "done", final: 1, park_reasons: "[]" },
          {
            run_id: "r-done-elsewhere",
            outcome: "done",
            final: 1,
            park_reasons: '["by-maintainer"]',
          },
          { run_id: "r-in-review-parked", outcome: "parked", final: 0, park_reasons: "[]" },
          { run_id: "r-reconciled-done", outcome: "done", final: 1, park_reasons: "[]" },
          { run_id: "r-start-failed", outcome: "dropped", final: 0, park_reasons: "[]" },
        ]);
        const columns = db.connection
          .all<{ name: string }>("select name from pragma_table_info('run_outcomes')")
          .map((row) => row.name);
        expect(columns).not.toContain("end_kind");
        expect(columns).toContain("outcome");
      } finally {
        db.close();
      }
    }));

  it("gives a fresh database and a migrated one the same schema", () =>
    withTempDir(async (dir) => {
      const db = await migrated(dir);
      const fresh = await open(dir, "fresh");
      try {
        expect(schema(db.connection)).toEqual(schema(fresh.connection));
      } finally {
        db.close();
        fresh.close();
      }
    }));
});
