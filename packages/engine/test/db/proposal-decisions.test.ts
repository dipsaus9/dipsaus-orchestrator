// Migration 47 (DIPO-166): a proposal's row gains who decided it (`decided_by`) and the Backlog
// draft the lane filed for an accepted one (`draft_id`). A proposal stored before the migration
// keeps its row, open, with both null.

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

describe("migration 47 on a database at version 46", () => {
  it("adds decided_by and draft_id to proposals and keeps the stored proposals open", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 46),
      );
      try {
        old.connection.immediate(() =>
          old.connection.exec(`insert into proposals (office_id, hash, story_key, run_id, kind,
              title, outcome, why, paths, created_at, updated_at)
            values ('off-1', 'h1', 'sto-1', 'run-1', 'follow-up', 'Split it', 'It is split.',
              'It grew.', '[]', 5, 5)`),
        );
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        const db = state.connection;
        expect(MIGRATIONS.find((step) => step.version === 47)?.name).toBe("proposal decisions");
        expect(TABLE_RETENTION["proposals"]?.tier).toBe("S");
        expect(
          db.all("select hash, state, decided_by, draft_id from proposals order by hash"),
        ).toEqual([{ hash: "h1", state: "open", decided_by: null, draft_id: null }]);
        db.exec(
          "update proposals set state = 'accepted', decided_by = 'cli', draft_id = 'DRAFT-4'",
        );
        expect(db.all("select state, decided_by, draft_id from proposals")).toEqual([
          { state: "accepted", decided_by: "cli", draft_id: "DRAFT-4" },
        ]);
      } finally {
        state.close();
      }
    }));
});
