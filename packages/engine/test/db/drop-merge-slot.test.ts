// Migration 58 (DIPO-350): drops `merge_slot`. GitHub's auto-merge replaced the merge slot, and
// whether auto-merge is on is GitHub's fact, read with the PR (0002). A database at version 57
// with a slot occupant loses the table and keeps its other rows; a fresh database and the migrated
// one have the same schema; the retention policy does not list it.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { TABLE_RETENTION } from "../../src/retention/policy";
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

/** Every table, index and trigger of the database, with its SQL, by name. */
function schema(db: Db): { type: string; name: string; sql: string | null }[] {
  return db.all<{ type: string; name: string; sql: string | null }>(
    `select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name`,
  );
}

const hasSlot = (db: Db): boolean =>
  db.all<{ name: string }>(`select name from sqlite_master where name = 'merge_slot'`).length > 0;

const BEFORE = MIGRATIONS.filter((step) => step.version <= 57);

describe("migration 58 (DIPO-350)", () => {
  it("drops merge_slot of a database at version 57 with an occupant, and keeps its other rows", () =>
    withTempDir(async (dir) => {
      expect(BEFORE.at(-1)?.version).toBe(57);
      const old = await open(dir, "migrated", BEFORE);
      try {
        const db = old.connection;
        db.immediate(() => {
          db.exec(`
            insert into offices (office_id, path, display_name, added_at, epoch, next_seq,
              replay_floor_seq)
              values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into merge_slot (office_id, kind, pr_number, repo, branch, run_id, phase,
              pushed_head, attempts, checks_since, sync_mode, merge, entered_at)
              values ('off-1', 'story', 7, 'o/r', 'DIPO-7/a', 'run-1', 'checks', 'abc', 1, 3,
                'onConflict', null, 5);
          `);
        });
        expect(hasSlot(db)).toBe(true);
      } finally {
        old.close();
      }
      const migrated = await open(dir, "migrated");
      try {
        const db = migrated.connection;
        expect(hasSlot(db)).toBe(false);
        expect(
          db.all<{ version: number }>("select max(version) as version from schema_migrations")[0]
            ?.version,
        ).toBeGreaterThanOrEqual(58);
        expect(db.all("select office_id from offices")).toEqual([{ office_id: "off-1" }]);
      } finally {
        migrated.close();
      }
    }));

  it("gives a fresh and a migrated database the same schema", () =>
    withTempDir(async (dir) => {
      const old = await open(dir, "migrated", BEFORE);
      old.close();
      const migrated = await open(dir, "migrated");
      const fresh = await open(dir, "fresh");
      try {
        expect(schema(migrated.connection)).toEqual(schema(fresh.connection));
        expect(hasSlot(fresh.connection)).toBe(false);
      } finally {
        migrated.close();
        fresh.close();
      }
    }));

  it("does not list merge_slot in the retention policy", () => {
    expect(Object.hasOwn(TABLE_RETENTION, "merge_slot")).toBe(false);
  });
});
