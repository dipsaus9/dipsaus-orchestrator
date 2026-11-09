// Migration 10 (DIPO-468): `parks` takes the resolution `merged`, and the parks a database already
// holds are kept as they were, open and resolved alike, with their indexes.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { OfficeId } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { MIGRATIONS } from "../../src/db/schema";
import { openParkIds, resolvePark } from "../../src/run-state/park-records";
import { localMounts, memoryLogger } from "./helpers";

const OFFICE = OfficeId.parse("off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");

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

describe("the parks at the upgrade to migration 10 (DIPO-468)", () => {
  it("keeps every park and accepts a park resolved as merged", () =>
    withTempDir(async (dir) => {
      const clock = new ManualClock();
      const before = await openStateDatabase(options(dir, MIGRATIONS.slice(0, 9), clock));
      try {
        const db = before.connection;
        db.immediate(() => {
          db.run(
            `insert into offices (office_id, path, display_name, added_at, next_seq)
             values ($office, '/repos/demo', 'demo', 0, 1)`,
            { office: OFFICE },
          );
          db.run(
            `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail, at,
               resolved_at, resolved_how)
             values ($office, 1, 'sto_1', 'TASK-1', null, 'conflict', 'old', 1, 2, 'resume'),
                    ($office, 2, 'sto_1', 'TASK-1', null, 'verify-failing', 'red', 3, null, null)`,
            { office: OFFICE },
          );
          // Before the upgrade the resolution is refused.
          expect(() =>
            db.run(
              `update parks set resolved_at = 4, resolved_how = 'merged'
                where office_id = $office and park_id = 2`,
              { office: OFFICE },
            ),
          ).toThrow();
        });
      } finally {
        before.close();
      }

      const state = await openStateDatabase(options(dir, MIGRATIONS, clock));
      try {
        const office = state.office(OFFICE);
        expect(openParkIds(office, "sto_1")).toEqual([2]);
        office.immediate(() => resolvePark(office, 2, "merged", 4));
        expect(openParkIds(office, "sto_1")).toEqual([]);
        expect(
          office.all<{ park_id: number; resolved_how: string; detail: string }>(
            "select park_id, resolved_how, detail from parks where office_id = $office_id order by park_id",
          ),
        ).toEqual([
          { park_id: 1, resolved_how: "resume", detail: "old" },
          { park_id: 2, resolved_how: "merged", detail: "red" },
        ]);
        const indexes = state.connection
          .all<{ name: string }>(
            "select name from sqlite_master where type = 'index' and tbl_name = 'parks' and name like 'parks_%' order by name",
          )
          .map((row) => row.name);
        expect(indexes).toEqual(["parks_key", "parks_open"]);
      } finally {
        state.close();
      }
    }));
});
