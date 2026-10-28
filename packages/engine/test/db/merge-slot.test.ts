// Migration 48 (DIPO-150): `merge_slot` (one occupant per office, a story PR names its run; migration
// 58 drops it again), the merge gate's head and override columns on `gates`, and `parks.resolved_how`
// gaining `override` with the park rows kept across the rebuild.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { localMounts, memoryLogger } from "./helpers";

// Migration 57 (DIPO-344) drops `parks.cause` and the question trigger, so these steps are read as
// they left the schema.
const BEFORE_57 = MIGRATIONS.filter((step) => step.version <= 56);

const open = (dir: string, migrations?: readonly Migration[]) =>
  openStateDatabase({
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock: new ManualClock(),
    engineVersion: "0.0.0-test",
    ...(migrations === undefined ? {} : { migrations }),
  });

const slot = (kind: string, run: string | null, phase = "sync") => `insert into merge_slot
    (office_id, kind, pr_number, repo, branch, run_id, phase, pushed_head, attempts, checks_since,
     sync_mode, entered_at)
  values ('off-1', '${kind}', 7, 'o/r', 'b', ${run === null ? "null" : `'${run}'`}, '${phase}',
    null, 0, null, 'onConflict', 5)`;

describe("migration 48 on a database at version 47", () => {
  it("creates merge_slot with tier P, adds the gate columns and keeps the parks with override allowed", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 47),
      );
      try {
        old.connection.immediate(() =>
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state,
              detail, last_good_commit, at, resolved_at, resolved_how, cause)
            values ('off-1', 1, 'sto-1', 'DIPO-1', 'run-1', 'review-blocked', 'In Review', 'd',
              null, 3, null, null, 'rounds')`),
        );
        expect(() =>
          old.connection.exec(
            "update parks set resolved_at = 4, resolved_how = 'override' where park_id = 1",
          ),
        ).toThrow();
      } finally {
        old.close();
      }

      const state = await open(dir, BEFORE_57);
      try {
        const db = state.connection;
        expect(MIGRATIONS.find((step) => step.version === 48)?.name).toBe("merge slot");
        // The park survived the rebuild, cause and all, and may now be resolved as an override.
        expect(db.all("select park_id, reason, cause from parks")).toEqual([
          { park_id: 1, reason: "review-blocked", cause: "rounds" },
        ]);
        db.exec("update parks set resolved_at = 4, resolved_how = 'override' where park_id = 1");
        expect(() =>
          db.exec("update parks set resolved_how = 'other' where park_id = 1"),
        ).toThrow();
        expect(() => db.exec("update parks set resolved_at = null where park_id = 1")).toThrow();

        // One occupant per office; a story PR names its run, a backlog PR none.
        db.exec(slot("story", "run-1", "close-out"));
        expect(() => db.exec(slot("backlog", null))).toThrow();
        db.exec("delete from merge_slot");
        db.exec(slot("backlog", null));
        db.exec("delete from merge_slot");
        expect(() => db.exec(slot("story", null))).toThrow();
        expect(() => db.exec(slot("backlog", "run-1"))).toThrow();
        expect(() => db.exec(slot("story", "run-1", "nowhere"))).toThrow();
        // The sync's planned merge is kept while the branch moves to it (step `record`).
        db.exec(slot("story", "run-1", "record"));
        db.exec(`update merge_slot set merge = '{}'`);
        db.exec("delete from merge_slot");

        // The merge gate's head and the review gate it overrides.
        const columns = db
          .all<{ name: string }>("pragma table_info(gates)")
          .map((column) => column.name);
        expect(columns).toEqual(expect.arrayContaining(["head_sha", "override_of"]));
      } finally {
        state.close();
      }
    }));
});
