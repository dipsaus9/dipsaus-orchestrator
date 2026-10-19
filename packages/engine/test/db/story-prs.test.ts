// Migration 36 (DIPO-144): `story_prs`, retention tier S.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { MIGRATIONS } from "../../src/db/schema";
import { TABLE_RETENTION } from "../../src/retention/policy";
import { localMounts, memoryLogger } from "./helpers";

describe("migration 36", () => {
  it("creates story_prs with the columns of 0019 section 16 and keeps the rows of version 35", () =>
    withTempDir(async (dir) => {
      const open = (migrations?: typeof MIGRATIONS) =>
        openStateDatabase({
          stateDir: join(dir, "state"),
          logger: memoryLogger(),
          readMounts: localMounts,
          clock: new ManualClock(),
          engineVersion: "0.0.0-test",
          ...(migrations === undefined ? {} : { migrations }),
        });
      const old = await open(MIGRATIONS.filter((step) => step.version <= 35));
      try {
        old.connection.immediate(() =>
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0)`),
        );
        expect(
          old.connection.all("select name from sqlite_master where name = 'story_prs'"),
        ).toEqual([]);
      } finally {
        old.close();
      }
      const state = await open();
      try {
        const db = state.connection;
        expect(
          db.get<{ user_version: number }>("pragma user_version")?.user_version,
        ).toBeGreaterThanOrEqual(36);
        expect(
          db
            .all<{ name: string }>("select name from pragma_table_info('story_prs')")
            .map((c) => c.name),
        ).toEqual([
          "office_id",
          "run_id",
          "key",
          "pr_number",
          "url",
          "branch",
          "base",
          "head_sha",
          "state",
          "title",
          "body_hash",
          "opened_at",
          "closed_at",
        ]);
        expect(db.all("select office_id from offices")).toEqual([{ office_id: "off-1" }]);
        expect(() =>
          db.immediate(() =>
            db.exec(`insert into story_prs values ('off-1', 'r', 'k', 1, 'u', 'b', 'm', 'h',
              'draft', 't', 'x', 0, null)`),
          ),
        ).toThrow();
      } finally {
        state.close();
      }
      expect(TABLE_RETENTION["story_prs"]?.tier).toBe("S");
    }));
});
