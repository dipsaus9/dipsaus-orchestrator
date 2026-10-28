// Migration 58 (DIPO-360): `parks.from_state` goes, since the origin of a park is Backlog.md's (the
// F16 record's `from`); every other park column and row stays, the reason included as history, and
// a fresh database has the same schema as a migrated one.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { localMounts, memoryLogger } from "./helpers";

const open = (dir: string, name: string, migrations?: readonly Migration[]) =>
  openStateDatabase({
    stateDir: join(dir, name),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock: new ManualClock(),
    engineVersion: "0.0.0-test",
    ...(migrations === undefined ? {} : { migrations }),
  });

type Db = { all<T>(sql: string): T[] };

function schema(db: Db): { type: string; name: string; sql: string | null }[] {
  return db.all<{ type: string; name: string; sql: string | null }>(
    `select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name`,
  );
}

const BEFORE_58 = MIGRATIONS.filter((step) => step.version <= 57);

describe("migration 58 (DIPO-360)", () => {
  it("drops parks.from_state and keeps every park row with its reason and detail", () =>
    withTempDir(async (dir) => {
      expect(BEFORE_58.at(-1)?.version).toBe(57);
      const old = await open(dir, "migrated", BEFORE_58);
      try {
        const db = old.connection;
        db.immediate(() =>
          db.exec(`insert into offices (office_id, path, display_name, added_at, epoch, next_seq,
              replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into parks (office_id, park_id, key, story_id, run_id, reason, from_state,
              detail, last_good_commit, at, resolved_at, resolved_how, resolved_note)
              values ('off-1', 1, 'stk_1', 'DIPO-1', null, 'by-maintainer', 'Ready', 'hold it',
                null, 1, 5, 'resume', 'go on'),
              ('off-1', 2, 'stk_2', 'DIPO-2', 'run-2', 'conflict', 'In Review', 'conflict in a.ts',
                'abc', 7, null, null, null);`),
        );
      } finally {
        old.close();
      }
      const migrated = await open(dir, "migrated");
      try {
        const db = migrated.connection;
        const columns = db
          .all<{ name: string }>("select name from pragma_table_info('parks')")
          .map((row) => row.name);
        expect(columns).not.toContain("from_state");
        expect(columns).toContain("reason");
        expect(db.all("select * from parks order by park_id")).toEqual([
          {
            office_id: "off-1",
            park_id: 1,
            key: "stk_1",
            story_id: "DIPO-1",
            run_id: null,
            reason: "by-maintainer",
            detail: "hold it",
            last_good_commit: null,
            at: 1,
            resolved_at: 5,
            resolved_how: "resume",
            resolved_note: "go on",
          },
          {
            office_id: "off-1",
            park_id: 2,
            key: "stk_2",
            story_id: "DIPO-2",
            run_id: "run-2",
            reason: "conflict",
            detail: "conflict in a.ts",
            last_good_commit: "abc",
            at: 7,
            resolved_at: null,
            resolved_how: null,
            resolved_note: null,
          },
        ]);
      } finally {
        migrated.close();
      }
    }));

  it("gives a fresh and a migrated database the same schema", () =>
    withTempDir(async (dir) => {
      const old = await open(dir, "migrated", BEFORE_58);
      old.close();
      const migrated = await open(dir, "migrated");
      const fresh = await open(dir, "fresh");
      try {
        expect(schema(migrated.connection)).toEqual(schema(fresh.connection));
      } finally {
        migrated.close();
        fresh.close();
      }
    }));
});
