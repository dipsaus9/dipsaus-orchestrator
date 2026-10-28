// Migration 65 (DIPO-349): a story has no Mac worktree and no port slot. A database at version 64
// with rows in every changed table keeps its runs (and the rows that reference them), rekeys the
// worker notes and context packs by story branch, drops run_ports and the worktree columns, and
// gets the leftover_worktrees table; a fresh database and the migrated one have the same schema.

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
  db.all<{ name: string }>(`pragma table_info(${table})`).map((column) => column.name);

const BEFORE = MIGRATIONS.filter((step) => step.version <= 64);

/** Rows at version 64: two claims with worktrees, their runs, notes, packs, ports and leftovers. */
const ROWS = `
insert into offices (office_id, path, display_name, added_at, epoch, next_seq, replay_floor_seq)
  values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
insert into runs (office_id, run_id, kind, key, story_id, role, model, start_sha, branch,
  worktree, slot, budget_unit, budget_limit, loop_cap, config_hash, started_at, backstop_snapshot)
  values
  ('off-1', 'run-1', 'story', 'sto-1', 'DIPO-1', 'developer', 'm', 'a', 'DIPO-1/one', '/t/DIPO-1',
    3, 'tokens', 10, 3, 'h', 1, '{"head":"a"}'),
  ('off-1', 'run-2', 'story', 'sto-2', 'DIPO-2', 'developer', 'm', 'b', 'DIPO-2/two', '/t/DIPO-2',
    null, 'tokens', 10, 3, 'h', 2, null),
  ('off-1', 'run-3', 'session', null, null, 'developer', 'm', null, null, null, null, 'tokens',
    10, 3, 'h', 3, null);
insert into run_intents (office_id, run_id, intent_id, kind, detail, state, created_at)
  values ('off-1', 'run-1', 1, 'stop', 'd', 'sent', 5);
insert into claims (office_id, run_id, key, story_id, branch, worktree, base, base_sha, start_sha,
  claim_sha, reused, admin_dir, snap_commondir, snap_gitdir, snap_pointer, first_feedback,
  claimed_at)
  values
  ('off-1', 'run-1', 'sto-1', 'DIPO-1', 'DIPO-1/one', '/t/DIPO-1', 'main', 'a', 'a', 'c', 0,
    '/g/1', '/g', '/g/1', 'gitdir: /g/1', null, 1),
  ('off-1', 'run-2', 'sto-2', 'DIPO-2', 'DIPO-2/two', '/t/DIPO-2', 'main', 'b', 'b', null, 0,
    '/g/2', '/g', '/g/2', 'gitdir: /g/2', 'conflict', 2);
insert into worker_notes (office_id, worktree, agent_id, run_id, story_key, role, text,
  recorded_at)
  values
  ('off-1', '/t/DIPO-1', 'agt-1', 'run-1', 'sto-1', 'developer', 'next: tests', 7),
  ('off-1', '/t/gone', 'agt-9', 'run-9', null, 'developer', 'no claim', 8);
insert into context_packs (office_id, worktree, head_sha, blob_ids, provider, pack_sha256,
  built_at)
  values
  ('off-1', '/t/DIPO-2', 'b', '[]', 'p', 's', 9),
  ('off-1', '/t/gone', 'z', '[]', 'p', 's', 10);
insert into run_profiles (office_id, profile_id, scanned_at, commit_sha, fingerprint, toolchain,
  conformance, deviations, current)
  values ('off-1', 1, 0, 'a', 'f', '{}', 'conforming', '[]', 1);
insert into run_ports (office_id, profile_id, dir, port, source, confidence, evidence,
  fixed_in_code, honours_port)
  values ('off-1', 1, '.', 5173, 'vite', 'high', 'e', 0, 1);
insert into done_elsewhere (office_id, run_id, key, story_id, branch, worktree, base, released_at,
  worktree_kept, files)
  values ('off-1', 'run-2', 'sto-2', 'DIPO-2', 'DIPO-2/two', '/t/DIPO-2', 'main', 3, 1, '[]');
`;

describe("migration 65 (DIPO-349)", () => {
  it("keeps the runs and their references, rekeys notes and packs by branch, and drops the worktree columns", () =>
    withTempDir(async (dir) => {
      expect(BEFORE.at(-1)?.version).toBe(64);
      const old = await open(dir, "migrated", BEFORE);
      try {
        old.connection.immediate(() => old.connection.exec(ROWS));
      } finally {
        old.close();
      }
      const migrated = await open(dir, "migrated");
      try {
        const db = migrated.connection;
        expect(
          db.all<{ version: number }>("select max(version) as version from schema_migrations")[0]
            ?.version,
        ).toBeGreaterThanOrEqual(65);
        expect(db.all("select run_id, kind, branch from runs order by run_id")).toEqual([
          { run_id: "run-1", kind: "story", branch: "DIPO-1/one" },
          { run_id: "run-2", kind: "story", branch: "DIPO-2/two" },
          { run_id: "run-3", kind: "session", branch: null },
        ]);
        expect(db.all("select run_id, intent_id from run_intents")).toEqual([
          { run_id: "run-1", intent_id: 1 },
        ]);
        expect(db.all("pragma foreign_key_check")).toEqual([]);
        for (const column of ["worktree", "slot", "backstop_snapshot"])
          expect(columns(db, "runs")).not.toContain(column);
        for (const column of [
          "worktree",
          "admin_dir",
          "snap_commondir",
          "snap_gitdir",
          "snap_pointer",
          "first_feedback",
        ])
          expect(columns(db, "claims")).not.toContain(column);
        for (const column of ["worktree", "worktree_kept", "files"])
          expect(columns(db, "done_elsewhere")).not.toContain(column);
        expect(db.all("select run_id, branch, claim_sha from claims order by run_id")).toEqual([
          { run_id: "run-1", branch: "DIPO-1/one", claim_sha: "c" },
          { run_id: "run-2", branch: "DIPO-2/two", claim_sha: null },
        ]);
        // Notes and packs follow their claim's branch; a row without a claim is dropped.
        expect(db.all("select branch, agent_id, text from worker_notes")).toEqual([
          { branch: "DIPO-1/one", agent_id: "agt-1", text: "next: tests" },
        ]);
        expect(db.all("select branch, head_sha from context_packs")).toEqual([
          { branch: "DIPO-2/two", head_sha: "b" },
        ]);
        expect(db.all("select run_id, branch from done_elsewhere")).toEqual([
          { run_id: "run-2", branch: "DIPO-2/two" },
        ]);
        expect(
          db.all(
            `select name from sqlite_master where name in ('run_ports', 'leftover_worktrees')`,
          ),
        ).toEqual([{ name: "leftover_worktrees" }]);
        // A story run without a branch is still refused by the rebuilt check.
        expect(() =>
          db.exec(`insert into runs (office_id, run_id, kind, key, story_id, role, model,
            start_sha, budget_unit, budget_limit, loop_cap, config_hash, started_at)
            values ('off-1', 'run-4', 'story', 'sto-4', 'DIPO-4', 'developer', 'm', 'a', 'tokens',
              10, 3, 'h', 4)`),
        ).toThrow();
      } finally {
        migrated.close();
      }
    }));

  it("gives a fresh and a migrated database the same schema", () =>
    withTempDir(async (dir) => {
      const old = await open(dir, "migrated", BEFORE);
      try {
        old.connection.immediate(() => old.connection.exec(ROWS));
      } finally {
        old.close();
      }
      const migrated = await open(dir, "migrated");
      const fresh = await open(dir, "fresh");
      try {
        expect(schema(migrated.connection)).toEqual(schema(fresh.connection));
      } finally {
        migrated.close();
        fresh.close();
      }
    }));

  it("lists leftover_worktrees and no longer run_ports in the retention policy", () => {
    expect(Object.hasOwn(TABLE_RETENTION, "run_ports")).toBe(false);
    expect(Object.hasOwn(TABLE_RETENTION, "leftover_worktrees")).toBe(true);
  });
});
