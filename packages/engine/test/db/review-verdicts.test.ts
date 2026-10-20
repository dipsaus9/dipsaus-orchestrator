// Migration 39 (DIPO-146): `review_verdicts` (retention tier S) and the review loop caps on `runs`.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { MIGRATIONS } from "../../src/db/schema";
import { TABLE_RETENTION } from "../../src/retention/policy";
import { localMounts, memoryLogger } from "./helpers";

const RUN_CAP_COLUMNS = [
  "ci_cap",
  "conflict_cap",
  "review_max_turns",
  "review_max_minutes",
  "review_allowance",
];

function columns(db: { all<T>(sql: string): T[] }, table: string): string[] {
  return db
    .all<{ name: string }>(`select name from pragma_table_info('${table}')`)
    .map((c) => c.name);
}

describe("migration 39", () => {
  it("creates review_verdicts, adds the runs cap columns and keeps the rows of version 38", () =>
    withTempDir(async (dir) => {
      const open = (migrations?: typeof MIGRATIONS) =>
        openStateDatabase({
          stateDir: join(dir, "state"),
          logger: memoryLogger(),
          readMounts: localMounts,
          clock: new ManualClock(),
          engineVersion: "0.0.0-test",
          ...(migrations === undefined ? {} : { migrations }),
        });
      const old = await open(MIGRATIONS.filter((step) => step.version <= 38));
      try {
        old.connection.immediate(() =>
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
              loop_cap, config_hash, started_at)
            values ('off-1', 'run-1', 'session', 'developer', 'sonnet', 'tokens', 1, 3, 'h', 0)`),
        );
        expect(
          old.connection.all("select name from sqlite_master where name = 'review_verdicts'"),
        ).toEqual([]);
        expect(columns(old.connection, "runs")).not.toContain("ci_cap");
      } finally {
        old.close();
      }
      const state = await open();
      try {
        const db = state.connection;
        expect(
          db.get<{ user_version: number }>("pragma user_version")?.user_version,
        ).toBeGreaterThanOrEqual(39);
        expect(columns(db, "review_verdicts")).toEqual([
          "office_id",
          "gate_id",
          "run_id",
          "key",
          "round",
          "agent_id",
          "model",
          "commit_sha",
          "code_tree_key",
          "verdict",
          "criteria",
          "findings",
          "summary",
          "validation_notes",
          "comment_url",
          "carried_from",
          "override_note",
          "override_at",
          "decided_at",
        ]);
        expect(columns(db, "runs")).toEqual(expect.arrayContaining(RUN_CAP_COLUMNS));
        // A run started before the caps were kept has none.
        expect(
          db.get<Record<string, unknown>>(
            `select ci_cap, conflict_cap, review_max_turns, review_max_minutes, review_allowance
               from runs where run_id = 'run-1'`,
          ),
        ).toEqual({
          ci_cap: null,
          conflict_cap: null,
          review_max_turns: null,
          review_max_minutes: null,
          review_allowance: null,
        });
        const insert = (verdict: string, overrideNote: string | null, overrideAt: number | null) =>
          db.immediate(() =>
            db.run(
              `insert into review_verdicts values ('off-1', $gate, 'run-1', 'k', 1, null, 'opus',
                 'c', 't', $verdict, '[]', '[]', '', '[]', null, null, $note, $at, 0)`,
              { gate: `gat-${verdict}-${overrideAt}`, verdict, note: overrideNote, at: overrideAt },
            ),
          );
        insert("approved", null, null);
        insert("blocked", "merge it", 5);
        expect(() => insert("pending", null, null)).toThrow();
        // An override has its note and its time, or neither.
        expect(() => insert("blocked", "merge it", null)).toThrow();
      } finally {
        state.close();
      }
      expect(TABLE_RETENTION["review_verdicts"]?.tier).toBe("S");
    }));
});
