// Migration 40 (DIPO-183): `base_verifies`, what the office's verify said about a base commit. A
// fresh database and one migrated from version 39 have the same table, and the retention policy
// lists it.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { MIGRATIONS } from "../../src/db/schema";
import { TABLE_RETENTION } from "../../src/retention/policy";
import { localMounts, memoryLogger } from "./helpers";

const COLUMNS = [
  "office_id",
  "base_sha",
  "config_hash",
  "run_id",
  "passed",
  "failing",
  "output_tail",
  "ran_at",
];

type Db = { all<T>(sql: string): T[] };

function shape(db: Db) {
  return {
    columns: db
      .all<{ name: string; type: string; notnull: number; pk: number }>(
        `select name, type, "notnull", pk from pragma_table_info('base_verifies')`,
      )
      .map((c) => [c.name, c.type, c.notnull, c.pk]),
    sql: db.all<{ sql: string }>(`select sql from sqlite_master where name = 'base_verifies'`),
  };
}

describe("migration 40", () => {
  it("gives a fresh and a migrated database the same base_verifies table", () =>
    withTempDir(async (dir) => {
      const open = (name: string, migrations?: typeof MIGRATIONS) =>
        openStateDatabase({
          stateDir: join(dir, name),
          logger: memoryLogger(),
          readMounts: localMounts,
          clock: new ManualClock(),
          engineVersion: "0.0.0-test",
          ...(migrations === undefined ? {} : { migrations }),
        });
      const old = await open(
        "migrated",
        MIGRATIONS.filter((step) => step.version <= 39),
      );
      try {
        expect(
          old.connection.all("select name from sqlite_master where name = 'base_verifies'"),
        ).toEqual([]);
      } finally {
        old.close();
      }
      const migrated = await open("migrated");
      const fresh = await open("fresh");
      try {
        expect(shape(migrated.connection)).toEqual(shape(fresh.connection));
        expect(shape(fresh.connection).columns.map(([name]) => name)).toEqual(COLUMNS);
        expect(
          migrated.connection.get<{ version: number }>(
            "select max(version) as version from schema_migrations",
          )?.version,
        ).toBeGreaterThanOrEqual(40);

        const db = fresh.connection;
        db.immediate(() =>
          db.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0)`),
        );
        const insert = (passed: number, failing: string, tail: string | null, sha = "a") =>
          db.immediate(() =>
            db.run(
              `insert into base_verifies values ('off-1', $sha, 'h', 'run-1', $passed, $failing,
                 $tail, 0)`,
              { sha, passed, failing, tail },
            ),
          );
        insert(1, "[]", null, "green");
        insert(0, '["a test"]', null, "red");
        insert(0, "[]", "the end of the output", "tail");
        // A green base has no failing tests and no tail; the flag is 0 or 1.
        expect(() => insert(1, '["a test"]', null, "x")).toThrow();
        expect(() => insert(1, "[]", "tail", "y")).toThrow();
        expect(() => insert(2, "[]", null, "z")).toThrow();
        // One row per office, base commit and configuration.
        expect(() => insert(1, "[]", null, "green")).toThrow();
      } finally {
        migrated.close();
        fresh.close();
      }
    }));

  it("lists base_verifies in the retention policy", () => {
    expect(TABLE_RETENTION["base_verifies"]).toEqual({
      tier: "P",
      rule: expect.stringContaining("until purge"),
    });
  });
});
