// Migration 56 (DIPO-342): drops `verify_results`, `base_verifies` and `nudge_sources`, which no
// live path writes since the move to boxes. A database at version 55 with rows in each loses the
// three tables and keeps its other rows; a fresh database and the migrated one have the same
// schema; the retention policy lists none of the three.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { TABLE_RETENTION } from "../../src/retention/policy";
import { localMounts, memoryLogger } from "./helpers";

const DROPPED = ["base_verifies", "nudge_sources", "verify_results"];

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

function tables(db: Db, names: readonly string[]): string[] {
  return db
    .all<{ name: string }>(`select name from sqlite_master where type = 'table' order by name`)
    .map((row) => row.name)
    .filter((name) => names.includes(name));
}

describe("migration 56 (DIPO-342)", () => {
  it("drops the three tables of a database at version 55 and keeps its other rows", () =>
    withTempDir(async (dir) => {
      const before = MIGRATIONS.filter((step) => step.version <= 55);
      expect(before.at(-1)?.version).toBe(55);
      const old = await open(dir, "migrated", before);
      try {
        const db = old.connection;
        expect(tables(db, DROPPED)).toEqual(DROPPED);
        db.immediate(() => {
          db.exec(`
            insert into offices (office_id, path, display_name, added_at, epoch, next_seq,
              replay_floor_seq)
              values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into base_verifies values ('off-1', 'a', 'h', 'run-1', 1, '[]', null, 0);
            insert into nudge_sources (office_id, run_id, agent_id, kind, path, recorded_at)
              values ('off-1', 'run-1', 'agt-1', 'context', 'src/a.ts', 0);
            insert into verify_results (office_id, run_id, result_id, loop, profile, commands,
              exit_code, signal, timed_out, passed, duration_ms, output_from, output_to, at)
              values ('off-1', 'run-1', 1, 1, 'branch', '[]', 0, null, 0, 1, 1, 0, 0, 0);
          `);
        });
      } finally {
        old.close();
      }
      const migrated = await open(dir, "migrated");
      try {
        const db = migrated.connection;
        expect(tables(db, DROPPED)).toEqual([]);
        expect(
          db.get<{ version: number }>("select max(version) as version from schema_migrations")
            ?.version,
        ).toBeGreaterThanOrEqual(56);
        expect(db.all("select office_id from offices")).toEqual([{ office_id: "off-1" }]);
      } finally {
        migrated.close();
      }
    }));

  it("gives a fresh and a migrated database the same schema", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        "migrated",
        MIGRATIONS.filter((step) => step.version <= 55),
      );
      old.close();
      const migrated = await open(dir, "migrated");
      const fresh = await open(dir, "fresh");
      try {
        expect(schema(migrated.connection)).toEqual(schema(fresh.connection));
        expect(tables(fresh.connection, DROPPED)).toEqual([]);
      } finally {
        migrated.close();
        fresh.close();
      }
    }));

  it("lists none of the dropped tables in the retention policy", () => {
    for (const name of DROPPED) expect(Object.hasOwn(TABLE_RETENTION, name)).toBe(false);
  });
});
