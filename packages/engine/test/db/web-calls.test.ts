// Migration 37 (DIPO-164): web call counts by tool on `runs` and `run_outcomes`, 0 for a run from
// before the migration.

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

describe("migration 37 on a database at version 36", () => {
  it("adds the web call counts, 0 and 0 for an earlier run and its outcome", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 36),
      );
      try {
        old.connection.immediate(() => {
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0)`);
          old.connection.exec(`insert into runs (office_id, run_id, kind, role, model, budget_unit,
            budget_limit, loop_cap, config_hash, started_at)
            values ('off-1', 'r1', 'session', 'developer', 'haiku', 'tokens', 100, 1, 'cfg', 1)`);
          old.connection.exec(`insert into run_outcomes (office_id, run_id, role, model, outcome,
            park_reasons, loops, review_rounds, verify_failures, budget_tokens, minutes, ended_at)
            values ('off-1', 'r1', 'developer', 'haiku', 'in-review', '[]', 0, 0, 0, 0, 1, 2)`);
        });
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        expect(MIGRATIONS.find((step) => step.version === 37)?.name).toBe("web call counts");
        expect(
          state.connection.all("select web_searches, web_fetches from runs where run_id = 'r1'"),
        ).toEqual([{ web_searches: 0, web_fetches: 0 }]);
        expect(
          state.connection.all(
            "select web_searches, web_fetches from run_outcomes where run_id = 'r1'",
          ),
        ).toEqual([{ web_searches: 0, web_fetches: 0 }]);
      } finally {
        state.close();
      }
    }));
});
