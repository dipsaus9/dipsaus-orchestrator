// Migration 32 (DIPO-143): the start turn and minute caps of `runs`, and `run_grants`, kept with
// their run (retention tier S).

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { TABLE_RETENTION } from "../../src/retention/policy";
import { localMounts, memoryLogger } from "./helpers";

describe("migration 32: run caps and run grants", () => {
  it("adds max_turns and max_minutes to runs and the run_grants table with tier S", () =>
    withTempDir(async (dir) => {
      const state = await openStateDatabase({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
        clock: new ManualClock(),
        engineVersion: "0.0.0-test",
      });
      try {
        const columns = (table: string) =>
          state.connection
            .all<{ name: string }>(`select name from pragma_table_info('${table}')`)
            .map((row) => row.name);
        expect(columns("runs")).toContain("max_turns");
        expect(columns("runs")).toContain("max_minutes");
        expect(columns("run_grants")).toEqual([
          "office_id",
          "run_id",
          "grant_id",
          "kind",
          "amount",
          "note",
          "origin",
          "client",
          "at",
        ]);
        expect(TABLE_RETENTION.run_grants?.aged).toBe(true);
      } finally {
        state.close();
      }
    }));
});
