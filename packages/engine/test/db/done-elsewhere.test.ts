// Migration 44 (DIPO-161): `parks.resolved_how` accepts `done-elsewhere`, the parks of a database at
// version 43 stay, and `done_elsewhere` exists with its retention policy.

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

const resolve = (how: string): string =>
  `update parks set resolved_at = 2, resolved_how = '${how}' where office_id = 'off-1' and park_id = 1`;

describe("migration 44 on a database at version 43", () => {
  it("keeps the parks and their cause and accepts done-elsewhere", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 43),
      );
      try {
        old.connection.immediate(() => {
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0)`);
          old.connection.exec(`insert into parks (office_id, park_id, key, story_id, run_id, reason,
            from_state, detail, last_good_commit, at, cause)
            values ('off-1', 1, 'sto_1', 'DIPO-105', 'r1', 'budget-exceeded', 'In Progress',
              'turn cap 61 of 60', 'abc', 1, 'build')`);
        });
        expect(() => old.connection.exec(resolve("done-elsewhere"))).toThrow();
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        expect(MIGRATIONS.find((step) => step.version === 44)?.name).toBe("done elsewhere");
        expect(
          state.connection.all(
            "select park_id, reason, cause, last_good_commit, resolved_how from parks",
          ),
        ).toEqual([
          {
            park_id: 1,
            reason: "budget-exceeded",
            cause: "build",
            last_good_commit: "abc",
            resolved_how: null,
          },
        ]);
        state.connection.immediate(() => state.connection.exec(resolve("done-elsewhere")));
        expect(state.connection.all("select resolved_how from parks")).toEqual([
          { resolved_how: "done-elsewhere" },
        ]);
        expect(() => state.connection.exec(resolve("bogus"))).toThrow();
        expect(
          state.connection.all(
            "select name from sqlite_master where name like 'parks_%' order by name",
          ),
        ).toEqual([{ name: "parks_key" }, { name: "parks_open" }]);
        // The leftovers table, with what dipo discard clears.
        state.connection.immediate(() =>
          state.connection.exec(`insert into done_elsewhere (office_id, run_id, key, story_id,
            branch, worktree, base, released_at) values ('off-1', 'r1', 'sto_1', 'DIPO-105',
            'DIPO-105/x', '/wt', 'main', 3)`),
        );
        expect(
          state.connection.all(
            "select worktree_kept, branch_kept, commits, files from done_elsewhere",
          ),
        ).toEqual([{ worktree_kept: 0, branch_kept: 0, commits: "[]", files: "[]" }]);
        expect(() =>
          state.connection.exec(
            "update done_elsewhere set cleared_at = 4, cleared_how = 'bogus' where run_id = 'r1'",
          ),
        ).toThrow();
      } finally {
        state.close();
      }
    }));

  it("lists done_elsewhere in the retention policy as tier S", () => {
    expect(TABLE_RETENTION["done_elsewhere"]?.tier).toBe("S");
  });
});
