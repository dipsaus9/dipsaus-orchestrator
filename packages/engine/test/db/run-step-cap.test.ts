// Migration 38 (DIPO-205): `run_steps.kind` gains `cap`; the rows of a database at version 37 stay.

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
   values ('off-1', 'r1', 2, '${kind}', 'maxTurns: turn cap reached: 1 of 1 turns', 2)`;

describe("migration 38 on a database at version 37", () => {
  it("keeps the run steps and accepts the cap kind", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 37),
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
        expect(() => old.connection.exec(insertStep("cap"))).toThrow();
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        expect(MIGRATIONS.find((step) => step.version === 38)?.name).toBe("run step cap");
        state.connection.immediate(() => state.connection.exec(insertStep("cap")));
        expect(
          state.connection.all(
            "select step, kind from run_steps where run_id = 'r1' order by step",
          ),
        ).toEqual([
          { step: 1, kind: "phase" },
          { step: 2, kind: "cap" },
        ]);
        expect(() => state.connection.exec(insertStep("bogus"))).toThrow();
      } finally {
        state.close();
      }
    }));
});
