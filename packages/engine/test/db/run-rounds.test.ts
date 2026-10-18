// Migration 34 (DIPO-142): `parks.cause`, the place wait of `runs`, the run step kinds of the
// review loop and the final `run_outcomes` columns.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { MIGRATIONS } from "../../src/db/schema";
import { localMounts, memoryLogger } from "./helpers";

const open = (dir: string) =>
  openStateDatabase({
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock: new ManualClock(),
    engineVersion: "0.0.0-test",
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
