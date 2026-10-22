// Migration 43 (DIPO-148): `feedback_items` (retention tier S with its run): one row per feedback
// item a fix round carries, unique per run, signature and head, its text within 3,000 characters.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { TABLE_RETENTION } from "../../src/retention/policy";
import { localMounts, memoryLogger } from "./helpers";

const open = (dir: string, migrations?: readonly Migration[]) =>
  openStateDatabase({
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock: new ManualClock(),
    engineVersion: "0.0.0-test",
    ...(migrations === undefined ? {} : { migrations }),
  });

const insert = (
  id: number,
  fields: { signature?: string; head?: string; source?: string; text?: string } = {},
) => `insert into feedback_items (office_id, run_id, item_id, source, signature, head_sha, round,
    repeat, intent_id, sent_at, text, created_at)
  values ('off-1', 'run-1', ${id}, '${fields.source ?? "ci"}', '${fields.signature ?? "sig-1"}',
    '${fields.head ?? "h1"}', 1, 0, 1, null, '${fields.text ?? "Required check ci-ok failed."}', 5)`;

describe("migration 43 on a database at version 42", () => {
  it("creates feedback_items with tier S, keeps the runs, and refuses a second row per signature and head", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 42),
      );
      try {
        old.connection.immediate(() =>
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
              loop_cap, config_hash, started_at)
            values ('off-1', 'run-1', 'session', 'developer', 'sonnet', 'tokens', 1, 3, 'h', 0)`),
        );
        expect(
          old.connection.all("select name from sqlite_master where name = 'feedback_items'"),
        ).toEqual([]);
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        const db = state.connection;
        expect(MIGRATIONS.find((step) => step.version === 43)?.name).toBe("feedback items");
        expect(TABLE_RETENTION["feedback_items"]?.tier).toBe("S");
        expect(db.all("select run_id from runs")).toEqual([{ run_id: "run-1" }]);
        db.exec(insert(1));
        // The same signature on a later head is a row of its own: a repeat.
        db.exec(insert(2, { head: "h2" }));
        // Never twice for one head: the send-once rule.
        expect(() => db.exec(insert(3))).toThrow();
        expect(() => db.exec(insert(4, { signature: "sig-2", source: "lint" }))).toThrow();
        expect(() => db.exec(insert(5, { signature: "sig-3", text: "x".repeat(3_001) }))).toThrow();
        db.exec(insert(6, { signature: "sig-4", text: "x".repeat(3_000), source: "reject" }));
        expect(
          db.all<{ item_id: number }>("select item_id from feedback_items order by item_id"),
        ).toEqual([{ item_id: 1 }, { item_id: 2 }, { item_id: 6 }]);
      } finally {
        state.close();
      }
    }));
});
