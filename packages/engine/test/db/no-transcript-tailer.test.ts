// Migration 71 (DIPO-368): the transcript tailer's cursors go, the check constraint allows host
// events only, and `usage_messages.output_state` goes. A database at version 70 with a transcript
// cursor and a host-events cursor keeps the host-events one; a fresh and a migrated database have
// the same schema.

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

type Db = { all<T>(sql: string): T[]; run(sql: string, params?: object): unknown };

/** Every table, index and trigger of the database, with its SQL, by name. */
function schema(db: Db): { type: string; name: string; sql: string | null }[] {
  return db.all<{ type: string; name: string; sql: string | null }>(
    `select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name`,
  );
}

const BEFORE = MIGRATIONS.filter((step) => step.version <= 70);

describe("migration 71 (DIPO-368)", () => {
  it("drops the transcript cursors of a database at version 70, keeps the host-events ones, and rejects a new transcript cursor", () =>
    withTempDir(async (dir) => {
      expect(BEFORE.at(-1)?.version).toBe(70);
      const old = await open(dir, "migrated", BEFORE);
      try {
        const db = old.connection;
        db.immediate(() => {
          db.exec(`
            insert into offices (office_id, path, display_name, added_at, next_seq)
              values ('off-1', '/repo', 'repo', 0, 1);
            insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
              loop_cap, config_hash, started_at)
              values ('off-1', 'r1', 'session', 'developer', 'haiku', 'tokens', 100, 1, 'cfg', 1);
            insert into agents (office_id, agent_id, run_id, role, model, adapter_version,
              started_at)
              values ('off-1', 'a1', 'r1', 'developer', 'haiku', '2.1.296', 1);
            insert into ingest_cursors (office_id, run_id, agent_id, source_kind, path,
              read_offset, parse_state, updated_at, drift_lines)
              values ('off-1', 'r1', 'a1', 'host-events', '/runs/r1/events.ndjson', 7, '{}', 2, 3),
                ('off-1', 'r1', 'a1', 'transcript', '/home/.claude/session.jsonl', 40,
                  '{"subagents":{}}', 2, 0);
            insert into usage_messages (office_id, agent_id, message_id, run_id, model, input,
              output, cache_create, cache_create_5m, cache_create_1h, cache_read, at)
              values ('off-1', 'a1', 'm1', 'r1', 'haiku', 1, 5, 0, 0, 0, 0, 1);
          `);
        });
      } finally {
        old.close();
      }

      const migrated = await open(dir, "migrated");
      try {
        const db = migrated.connection;
        expect(
          db.all<{ run_id: string; source_kind: string; read_offset: number; drift_lines: number }>(
            "select run_id, source_kind, read_offset, drift_lines from ingest_cursors",
          ),
        ).toEqual([{ run_id: "r1", source_kind: "host-events", read_offset: 7, drift_lines: 3 }]);
        expect(
          db
            .all<{ name: string }>(`select name from pragma_table_info('usage_messages')`)
            .some((column) => column.name === "output_state"),
        ).toBe(false);
        expect(
          db.all<{ message_id: string; output: number }>(
            "select message_id, output from usage_messages",
          ),
        ).toEqual([{ message_id: "m1", output: 5 }]);
        expect(() =>
          db.run(
            `insert into ingest_cursors (office_id, run_id, agent_id, source_kind, path, parse_state,
               updated_at)
             values ('off-1', 'r1', 'a1', 'transcript', '/x.jsonl', '{}', 3)`,
          ),
        ).toThrow();
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
