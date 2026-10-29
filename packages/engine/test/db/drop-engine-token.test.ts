// Migration 68 (DIPO-369): `worker_hosts.engine_token` goes, since no host reads it. A database at
// version 67 with a host row that holds a token loses the column and keeps the row; a fresh
// database and the migrated one have the same schema.

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

/** Every table, index and trigger of the database, with its SQL, by name. */
function schema(db: Db): { type: string; name: string; sql: string | null }[] {
  return db.all<{ type: string; name: string; sql: string | null }>(
    `select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name`,
  );
}

const hasTokenColumn = (db: Db): boolean =>
  db
    .all<{ name: string }>(`select name from pragma_table_info('worker_hosts')`)
    .some((column) => column.name === "engine_token");

const BEFORE = MIGRATIONS.filter((step) => step.version <= 67);

describe("migration 68 (DIPO-369)", () => {
  it("drops engine_token of a database at version 67 with a host row, and keeps the row", () =>
    withTempDir(async (dir) => {
      expect(BEFORE.at(-1)?.version).toBe(67);
      const old = await open(dir, "migrated", BEFORE);
      try {
        const db = old.connection;
        db.immediate(() => {
          db.exec(`
            insert into offices (office_id, path, display_name, added_at, epoch, next_seq,
              replay_floor_seq)
              values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
              protocol_version, run_dir, event_file, started_at, engine_token)
              values ('off-1', 'run-1', 'agt-1', 4242, 99, '/rt/hosts/run-1.sock', 2, '/runs/run-1',
                '/runs/run-1/events.ndjson', 5, '${"e".repeat(64)}');
          `);
        });
        expect(hasTokenColumn(db)).toBe(true);
      } finally {
        old.close();
      }
      const migrated = await open(dir, "migrated");
      try {
        const db = migrated.connection;
        expect(hasTokenColumn(db)).toBe(false);
        expect(
          db.all<{ version: number }>("select max(version) as version from schema_migrations")[0]
            ?.version,
        ).toBeGreaterThanOrEqual(68);
        expect(
          db.all<{ run_id: string; pid: number; socket_path: string }>(
            "select run_id, pid, socket_path from worker_hosts where office_id = 'off-1'",
          ),
        ).toEqual([{ run_id: "run-1", pid: 4242, socket_path: "/rt/hosts/run-1.sock" }]);
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
        expect(hasTokenColumn(fresh.connection)).toBe(false);
      } finally {
        migrated.close();
        fresh.close();
      }
    }));
});
