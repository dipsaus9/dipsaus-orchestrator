// Migration 41 (DIPO-299): `run_steps.kind` gains `ci-none`; the rows of a database at version 40
// stay.

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

const insertStep = (kind: string): string =>
  `insert into run_steps (office_id, run_id, step, kind, value, at)
   values ('off-1', 'r1', 2, '${kind}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2)`;

describe("migration 41 on a database at version 40", () => {
  it("keeps the run steps and accepts the ci-none kind", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 40),
      );
      try {
        old.connection.immediate(() => {
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0)`);
          old.connection.exec(`insert into runs (office_id, run_id, kind, role, model, budget_unit,
            budget_limit, loop_cap, config_hash, started_at)
            values ('off-1', 'r1', 'session', 'developer', 'haiku', 'tokens', 100, 1, 'cfg', 1)`);
          old.connection.exec(`insert into run_steps (office_id, run_id, step, kind, value, at)
            values ('off-1', 'r1', 1, 'phase', 'implement', 1)`);
        });
        expect(() => old.connection.exec(insertStep("ci-none"))).toThrow();
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        expect(MIGRATIONS.find((step) => step.version === 41)?.name).toBe("run step ci-none");
        state.connection.immediate(() => state.connection.exec(insertStep("ci-none")));
        expect(
          state.connection.all(
            "select step, kind from run_steps where run_id = 'r1' order by step",
          ),
        ).toEqual([
          { step: 1, kind: "phase" },
          { step: 2, kind: "ci-none" },
        ]);
        expect(() => state.connection.exec(insertStep("bogus"))).toThrow();
      } finally {
        state.close();
      }
    }));
});
