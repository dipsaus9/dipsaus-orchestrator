// Migration 46 (DIPO-149): `catch_ups` (retention tier S with its run): one row per base merge dipo
// made into a story branch (`merged`, with its commit) or found while the story was In Review
// (`found`, no commit), numbered per run.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { TABLE_RETENTION } from "../../src/retention/policy";
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

const insert = (id: number, kind: string, commit: string | null) => `insert into catch_ups
    (office_id, run_id, catch_up_id, kind, base, onto_sha, tip_sha, commit_sha, conflicts, at)
  values ('off-1', 'run-1', ${id}, '${kind}', 'main', 'o', 't',
    ${commit === null ? "null" : `'${commit}'`}, '[]', 5)`;

describe("migration 46 on a database at version 45", () => {
  it("creates catch_ups with tier S, keeps the runs, and holds a commit only for a merge", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 45),
      );
      try {
        old.connection.immediate(() =>
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
              loop_cap, config_hash, started_at)
            values ('off-1', 'run-1', 'session', 'developer', 'sonnet', 'tokens', 1, 3, 'h', 0)`),
        );
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        const db = state.connection;
        expect(MIGRATIONS.find((step) => step.version === 46)?.name).toBe("catch ups");
        expect(TABLE_RETENTION["catch_ups"]?.tier).toBe("S");
        expect(db.all("select run_id from runs")).toEqual([{ run_id: "run-1" }]);
        db.exec(insert(1, "merged", "c1"));
        db.exec(insert(2, "found", null));
        expect(() => db.exec(insert(3, "merged", null))).toThrow();
        expect(() => db.exec(insert(4, "found", "c4"))).toThrow();
        expect(() => db.exec(insert(5, "other", "c5"))).toThrow();
        expect(() => db.exec(insert(1, "found", null))).toThrow();
        expect(
          db.all<{ catch_up_id: number }>("select catch_up_id from catch_ups order by catch_up_id"),
        ).toEqual([{ catch_up_id: 1 }, { catch_up_id: 2 }]);
      } finally {
        state.close();
      }
    }));
});
