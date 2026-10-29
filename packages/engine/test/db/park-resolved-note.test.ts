// Migration 47 (DIPO-155): `parks.resolved_note`, the maintainer's note on the resume that
// resolved a park (0020 sections 3 and 15), kept with the park (retention tier S). The resume
// writing it is tested in test/run/resume-parks.test.ts.

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

describe("migration 47 on a database at version 46", () => {
  it("adds parks.resolved_note, keeps the parks, and holds a note on a resolved park", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 46),
      );
      try {
        old.connection.immediate(() =>
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into stories (office_id, key, story_id, provisional, first_seen_at)
            values ('off-1', 'stk_1', 'DIPO-1', 0, 0);
            insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state,
              detail, at)
            values ('off-1', 1, 'stk_1', 'DIPO-1', null, 'stopped', 'In Progress', 'x', 1)`),
        );
        const columns = old.connection
          .all<{ name: string }>("select name from pragma_table_info('parks')")
          .map((row) => row.name);
        expect(columns).not.toContain("resolved_note");
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        const db = state.connection;
        expect(MIGRATIONS.find((step) => step.version === 47)?.name).toBe("park resolved note");
        expect(TABLE_RETENTION["parks"]?.aged).toBe(true);
        expect(db.all("select park_id, resolved_note from parks")).toEqual([
          { park_id: 1, resolved_note: null },
        ]);
        db.immediate(() =>
          db.exec(`update parks set resolved_at = 2, resolved_how = 'resume',
            resolved_note = 'Use the shorter flag.' where park_id = 1`),
        );
        expect(db.all("select resolved_how, resolved_note from parks")).toEqual([
          { resolved_how: "resume", resolved_note: "Use the shorter flag." },
        ]);
      } finally {
        state.close();
      }
    }));
});
