// Migration 66 (DIPO-352): health is one of five states with the watchdog facts as evidence. A
// database at version 65 with watchdog rows and phase steps turns `quiet` and `no-output` into one
// `no-output` fact with `stuck_at`, drops `input-wait`, keeps `plan-limit` for the legacy office
// load, and turns the phase `verify` into `build`; a fresh database and the migrated one have the
// same schema.

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

const BEFORE = MIGRATIONS.filter((step) => step.version <= 65);

/**
 * Rows at version 65. run-1 is only quiet; run-2 was quiet, then stuck (both in effect); run-3 had
 * a cleared quiet and a cleared no-output; run-4 waits on a live question and was held by a plan
 * limit; run-5 has a cleared quiet and a cleared no-output with the same `since`.
 */
const ROWS = `
insert into offices (office_id, path, display_name, added_at, epoch, next_seq, replay_floor_seq)
  values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit, loop_cap,
  config_hash, started_at)
  values
  ('off-1', 'run-1', 'session', 'developer', 'm', 'tokens', 1, 3, 'h', 0),
  ('off-1', 'run-2', 'session', 'developer', 'm', 'tokens', 1, 3, 'h', 0),
  ('off-1', 'run-3', 'session', 'developer', 'm', 'tokens', 1, 3, 'h', 0),
  ('off-1', 'run-4', 'session', 'developer', 'm', 'tokens', 1, 3, 'h', 0),
  ('off-1', 'run-5', 'session', 'developer', 'm', 'tokens', 1, 3, 'h', 0);
insert into run_signals (office_id, run_id, signal, since, cleared_at)
  values
  ('off-1', 'run-1', 'quiet', 10, null),
  ('off-1', 'run-2', 'quiet', 10, null),
  ('off-1', 'run-2', 'no-output', 20, null),
  ('off-1', 'run-3', 'quiet', 10, 15),
  ('off-1', 'run-3', 'no-output', 30, 35),
  ('off-1', 'run-4', 'input-wait', 10, null),
  ('off-1', 'run-4', 'plan-limit', 12, null),
  ('off-1', 'run-5', 'quiet', 40, 50),
  ('off-1', 'run-5', 'no-output', 40, 50);
insert into run_steps (office_id, run_id, step, kind, value, at)
  values
  ('off-1', 'run-1', 1, 'phase', 'setup', 1),
  ('off-1', 'run-1', 2, 'phase', 'build', 2),
  ('off-1', 'run-1', 3, 'phase', 'verify', 3),
  ('off-1', 'run-1', 4, 'loop', 'verify', 4),
  ('off-1', 'run-1', 5, 'phase', 'review', 5);
`;

async function migrated(dir: string) {
  const old = await open(dir, "migrated", BEFORE);
  try {
    expect(old.connection.get<{ user_version: number }>("pragma user_version")?.user_version).toBe(
      65,
    );
    old.connection.immediate(() => old.connection.exec(ROWS));
  } finally {
    old.close();
  }
  return open(dir, "migrated");
}

describe("migration 66 (DIPO-352)", () => {
  it("makes quiet and no-output one no-output fact with stuck_at, drops input-wait and keeps plan-limit", () =>
    withTempDir(async (dir) => {
      const db = await migrated(dir);
      try {
        const rows = db.connection.all<{
          run_id: string;
          signal: string;
          since: number;
          cleared_at: number | null;
          stuck_at: number | null;
        }>(
          `select run_id, signal, since, cleared_at, stuck_at from run_signals
            order by run_id, since, signal`,
        );
        expect(rows).toEqual([
          { run_id: "run-1", signal: "no-output", since: 10, cleared_at: null, stuck_at: null },
          { run_id: "run-2", signal: "no-output", since: 20, cleared_at: null, stuck_at: 20 },
          { run_id: "run-3", signal: "no-output", since: 10, cleared_at: 15, stuck_at: null },
          { run_id: "run-3", signal: "no-output", since: 30, cleared_at: 35, stuck_at: 30 },
          { run_id: "run-4", signal: "plan-limit", since: 12, cleared_at: null, stuck_at: null },
          { run_id: "run-5", signal: "no-output", since: 40, cleared_at: 50, stuck_at: 40 },
        ]);
      } finally {
        db.close();
      }
    }));

  it("turns the phase verify into build and leaves other steps alone", () =>
    withTempDir(async (dir) => {
      const db = await migrated(dir);
      try {
        const steps = db.connection.all<{ kind: string; value: string }>(
          "select kind, value from run_steps where run_id = 'run-1' order by step",
        );
        expect(steps).toEqual([
          { kind: "phase", value: "setup" },
          { kind: "phase", value: "build" },
          { kind: "phase", value: "build" },
          { kind: "loop", value: "verify" },
          { kind: "phase", value: "review" },
        ]);
      } finally {
        db.close();
      }
    }));

  it("gives a fresh and a migrated database the same schema", () =>
    withTempDir(async (dir) => {
      const db = await migrated(dir);
      const fresh = await open(dir, "fresh");
      try {
        expect(schema(db.connection)).toEqual(schema(fresh.connection));
      } finally {
        db.close();
        fresh.close();
      }
    }));
});
