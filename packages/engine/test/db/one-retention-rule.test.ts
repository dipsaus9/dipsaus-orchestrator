// Migration 69 (DIPO-354): one retention rule and one backup (0007). A database at version 68 with
// rows loses the pricing tables, the cost estimate, the change-log tier, the epoch and the replay
// floor, and keeps the CLI's cost, the daily rollup, the change log and the offices; a host row an
// earlier binary left open after it ingested the exit ends at its agent's end (DIPO-330). A fresh
// database and the migrated one have the same schema.

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

const columns = (db: Db, table: string): string[] =>
  db.all<{ name: string }>(`select name from pragma_table_info('${table}')`).map((c) => c.name);

const tables = (db: Db): string[] =>
  db
    .all<{ name: string }>(`select name from sqlite_master where type = 'table' order by name`)
    .map((row) => row.name);

const BEFORE = MIGRATIONS.filter((step) => step.version <= 68);

const ROWS = `
insert into offices (office_id, path, display_name, added_at, epoch, next_seq, replay_floor_seq)
  values ('off-1', '/repo', 'repo', 0, 'e', 3, 1);
insert into change_log (office_id, seq, at, type, tier, delta)
  values ('off-1', 2, 5, 'engine.notice', 'S', '{}');
insert into pricing_catalogs (version, source, effective_date, checksum, imported_at)
  values (2, 'shipped', '2026-10-01', 'c', 0);
insert into pricing_rates (version, model, input, output, cache_write_5m, cache_write_1h,
  cache_read) values (2, 'claude-haiku-5-5', 1, 2, 3, 4, 5);
insert into pricing_checks (office_id, run_id, est_cost_micros, cli_cost_micros, raised_at)
  values ('off-1', 'run-1', 1, 2, 0);
insert into agents (office_id, agent_id, run_id, role, model, started_at, ended_at)
  values ('off-1', 'agt-done', 'run-1', 'developer', 'haiku', 0, 70);
insert into agents (office_id, agent_id, run_id, role, model, started_at, ended_at)
  values ('off-1', 'agt-live', 'run-2', 'developer', 'haiku', 0, null);
insert into usage_totals (office_id, run_id, agent_id, model, role, tier, est_cost_micros,
  pricing_version, cli_cost_micros, final, updated_at)
  values ('off-1', 'run-1', 'agt-done', 'claude-haiku-5-5', 'developer', 'M', 900, '2', 1000, 1, 0);
insert into usage_daily (office_id, day, role, tier, model, runs, est_cost_micros)
  values ('off-1', '2026-10-01', 'developer', 'M', 'claude-haiku-5-5', 1, 900);
insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
  protocol_version, run_dir, event_file, processed_offset, exit_code, started_at)
  values ('off-1', 'run-1', 'agt-done', 11, 1, '/s', 1, '/d', '/d/e', 420, 0, 0);
insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
  protocol_version, run_dir, event_file, processed_offset, started_at)
  values ('off-1', 'run-2', 'agt-live', 12, 1, '/s', 1, '/d', '/d/e', 30, 0);
`;

describe("migration 69 (DIPO-354)", () => {
  it("cuts the housekeeping of a database at version 68 with rows and keeps what stays", () =>
    withTempDir(async (dir) => {
      expect(BEFORE.at(-1)?.version).toBe(68);
      const old = await open(dir, "migrated", BEFORE);
      try {
        old.connection.immediate(() => old.connection.exec(ROWS));
      } finally {
        old.close();
      }
      const migrated = await open(dir, "migrated");
      try {
        const db = migrated.connection;
        for (const table of ["pricing_catalogs", "pricing_rates", "pricing_checks"]) {
          expect(tables(db)).not.toContain(table);
        }
        // The CLI's cost stays as the cost; the estimate goes.
        expect(columns(db, "usage_totals")).not.toContain("est_cost_micros");
        expect(columns(db, "usage_totals")).not.toContain("pricing_version");
        expect(db.all("select agent_id, cost_micros from usage_totals")).toEqual([
          { agent_id: "agt-done", cost_micros: 1000 },
        ]);
        expect(db.all("select day, cost_micros from usage_daily")).toEqual([
          { day: "2026-10-01", cost_micros: 900 },
        ]);
        // No tier, no epoch, no floor; the rows stay.
        expect(columns(db, "change_log")).not.toContain("tier");
        expect(db.all("select seq, type from change_log")).toEqual([
          { seq: 2, type: "engine.notice" },
        ]);
        expect(columns(db, "offices")).not.toContain("epoch");
        expect(columns(db, "offices")).not.toContain("replay_floor_seq");
        expect(db.all("select office_id, next_seq from offices")).toEqual([
          { office_id: "off-1", next_seq: 3 },
        ]);
        // The host whose exit was ingested ends with its agent; a live one stays open.
        expect(
          db.all("select agent_id, ended_at, final_offset from worker_hosts order by agent_id"),
        ).toEqual([
          { agent_id: "agt-done", ended_at: 70, final_offset: 420 },
          { agent_id: "agt-live", ended_at: null, final_offset: null },
        ]);
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
      } finally {
        migrated.close();
        fresh.close();
      }
    }));

  it("does not list the pricing checks in the retention policy", () => {
    expect(Object.hasOwn(TABLE_RETENTION, "pricing_checks")).toBe(false);
  });
});
