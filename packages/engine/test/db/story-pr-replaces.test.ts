// Migration 52 (DIPO-324): `story_prs.replaces`, the closed story PR a new one replaces (0020
// section 2, `stopped` / `pr-closed`), and `catch_ups.box_copy`, a merge dipo made outside the
// story's box until the box gets it. The replacement is tested in test/story-pr/prs.test.ts, the
// box copy in test/run/conflict-resume.test.ts and test/box/collisions.test.ts.

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

describe("migration 52 on a database at version 51", () => {
  it("adds story_prs.replaces, null for the PRs it keeps, and catch_ups.box_copy", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 51),
      );
      try {
        old.connection.immediate(() =>
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into story_prs values ('off-1', 'run-1', 'stk_1', 7, 'u', 'b', 'main', 'h',
              'closed', 't', 'x', 0, 1)`),
        );
        const columns = old.connection
          .all<{ name: string }>("select name from pragma_table_info('story_prs')")
          .map((row) => row.name);
        expect(columns).not.toContain("replaces");
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        const db = state.connection;
        expect(MIGRATIONS.find((step) => step.version === 52)?.name).toBe(
          "story pr replaces and box copies",
        );
        expect(db.all("select run_id, pr_number, replaces from story_prs")).toEqual([
          { run_id: "run-1", pr_number: 7, replaces: null },
        ]);
        db.immediate(() =>
          db.exec(`update story_prs set pr_number = 8, state = 'open', closed_at = null,
            replaces = 7 where run_id = 'run-1'`),
        );
        expect(db.all("select pr_number, state, replaces from story_prs")).toEqual([
          { pr_number: 8, state: "open", replaces: 7 },
        ]);
        // `catch_ups.box_copy`: pending or done only, null by default.
        const columns = db
          .all<{ name: string }>("select name from pragma_table_info('catch_ups')")
          .map((row) => row.name);
        expect(columns).toContain("box_copy");
        expect(() =>
          db.immediate(() =>
            db.exec(`insert into catch_ups (office_id, run_id, catch_up_id, kind, base, onto_sha,
              tip_sha, commit_sha, conflicts, at, box_copy)
              values ('off-1', 'run-1', 1, 'merged', 'main', 'o', 't', 'c', '[]', 0, 'maybe')`),
          ),
        ).toThrow();
      } finally {
        state.close();
      }
    }));
});
