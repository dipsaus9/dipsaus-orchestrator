// Migration 70 (DIPO-376): a run keeps Safe-Chain's refusals in `runs.safe_chain`. A database at
// version 69 with a run row gains the column, null for the run, and keeps the row; a value written
// since reads back, and one that does not parse reads back as unknown, never as no refusals. A
// fresh database and the migrated one have the same schema.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import type { OfficeId, RunId } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { OfficeHandle } from "../../src/db/office";
import { MIGRATIONS } from "../../src/db/schema";
import { findRun, recordSafeChain } from "../../src/run/records";
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

const BEFORE = MIGRATIONS.filter((step) => step.version <= 69);
const RUN = "run-1" as RunId;

const ROWS = `
insert into offices (office_id, path, display_name, added_at, next_seq)
  values ('off-1', '/repo', 'repo', 0, 1);
insert into runs (office_id, run_id, kind, key, story_id, tier, role, model, start_sha, branch,
  budget_unit, budget_limit, loop_cap, config_hash, started_at)
  values ('off-1', 'run-1', 'story', 'sto-1', 'DIPO-1', 'M', 'developer', 'haiku', 'b', 'DIPO-1/x',
    'tokens', 1000, 3, 'h', 0);
`;

describe("migration 70 (DIPO-376)", () => {
  it("adds runs.safe_chain to a database at version 69 with a run, and reads it back", () =>
    withTempDir(async (dir) => {
      expect(BEFORE.at(-1)?.version).toBe(69);
      const old = await open(dir, "migrated", BEFORE);
      try {
        old.connection.immediate(() => old.connection.exec(ROWS));
      } finally {
        old.close();
      }
      const migrated = await open(dir, "migrated");
      try {
        const office = new OfficeHandle(migrated.connection, "off-1" as OfficeId);
        const run = findRun(office, RUN);
        expect(run?.story).toBe("DIPO-1");
        expect(run?.safeChain).toBeNull();

        const record = {
          refusals: [
            {
              ecosystem: "npm",
              package: "safe-chain-test@0.0.1-security",
              reason: "Aikido's malware list marks it MALWARE",
            },
          ],
          unknown: [],
          mark: null,
        } as const;
        office.immediate(() => recordSafeChain(office, RUN, record));
        expect(findRun(office, RUN)?.safeChain).toEqual(record);

        // A value that does not parse is unknown for each log, never no refusals.
        migrated.connection.exec(
          `update runs set safe_chain = '{"refusals":' where run_id = 'run-1'`,
        );
        expect(findRun(office, RUN)?.safeChain).toEqual({
          refusals: [],
          unknown: [
            {
              ecosystem: "npm",
              why: "dipo's stored record of its Safe-Chain refusals cannot be read",
            },
            {
              ecosystem: "pypi",
              why: "dipo's stored record of its Safe-Chain refusals cannot be read",
            },
          ],
          mark: null,
        });
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
});
