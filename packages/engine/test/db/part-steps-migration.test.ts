// Migration 9 (DIPO-466): `run_steps` takes the `part` kind, and the steps a database already holds
// are kept as they were, so a run's CI attempts and phases read the same after the upgrade.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { OfficeId, RunId } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { MIGRATIONS } from "../../src/db/schema";
import { appendRunStep, runHandedPart, runRoundCounts, runSteps } from "../../src/records";
import { localMounts, memoryLogger } from "./helpers";

const OFFICE = OfficeId.parse("off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");
const RUN = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");
const HEAD = "a".repeat(40);
const PART = "b".repeat(40);

function options(dir: string, migrations: typeof MIGRATIONS, clock: ManualClock) {
  return {
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock,
    engineVersion: "0.0.0-test",
    migrations,
  };
}

describe("the run steps at the upgrade to migration 9 (DIPO-466)", () => {
  it("keeps every step and accepts a part step, which is no CI attempt", () =>
    withTempDir(async (dir) => {
      const clock = new ManualClock();
      const before = await openStateDatabase(options(dir, MIGRATIONS.slice(0, 8), clock));
      try {
        const db = before.connection;
        db.immediate(() => {
          db.run(
            `insert into offices (office_id, path, display_name, added_at, next_seq)
             values ($office, '/repos/demo', 'demo', 0, 1)`,
            { office: OFFICE },
          );
          db.run(
            `insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
               loop_cap, config_hash, started_at)
             values ($office, $run, 'session', 'planner', 'haiku', 'tokens', 1, 1, 'h', 0)`,
            { office: OFFICE, run: RUN },
          );
          for (const [step, kind, value] of [
            [1, "phase", "In Progress"],
            [2, "ci", HEAD],
            [3, "ci-rerun", HEAD],
          ] as const) {
            db.run(
              `insert into run_steps (office_id, run_id, step, kind, value, at)
               values ($office, $run, $step, $kind, $value, $step)`,
              { office: OFFICE, run: RUN, step, kind, value },
            );
          }
          // Before the upgrade the kind is refused.
          expect(() =>
            db.run(
              `insert into run_steps (office_id, run_id, step, kind, value, at)
               values ($office, $run, 4, 'part', $part, 4)`,
              { office: OFFICE, run: RUN, part: PART },
            ),
          ).toThrow();
        });
      } finally {
        before.close();
      }

      const state = await openStateDatabase(options(dir, MIGRATIONS, clock));
      try {
        const office = state.office(OFFICE);
        expect(runHandedPart(office, RUN)).toBe(false);
        office.immediate(() => appendRunStep(office, RUN, "part", PART, 4));
        expect(runSteps(office, RUN)).toEqual([
          { step: 1, kind: "phase", value: "In Progress", at: 1 },
          { step: 2, kind: "ci", value: HEAD, at: 2 },
          { step: 3, kind: "ci-rerun", value: HEAD, at: 3 },
          { step: 4, kind: "part", value: PART, at: 4 },
        ]);
        expect(runRoundCounts(office, RUN).ciAttempts).toBe(1);
        expect(runHandedPart(office, RUN)).toBe(true);
      } finally {
        state.close();
      }
    }));
});
