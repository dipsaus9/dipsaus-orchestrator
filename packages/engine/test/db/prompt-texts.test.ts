// Migration 33 (DIPO-137): `prompt_texts`, the prompt text of a worker session, retention tier R.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import { MIGRATIONS } from "../../src/db/schema";
import { TABLE_RETENTION } from "../../src/retention/policy";
import { localMounts, memoryLogger } from "./helpers";

describe("migration 33: prompt texts", () => {
  it("is registered last and adds the prompt_texts table with tier R", () =>
    withTempDir(async (dir) => {
      expect(MIGRATIONS.at(-1)?.name).toBe("prompt texts");
      expect(MIGRATIONS.at(-1)?.version).toBe(33);
      const state = await openStateDatabase({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
        clock: new ManualClock(),
        engineVersion: "0.0.0-test",
      });
      try {
        const columns = state.connection
          .all<{ name: string }>("select name from pragma_table_info('prompt_texts')")
          .map((row) => row.name);
        expect(columns).toEqual(["office_id", "run_id", "agent_id", "part", "text", "recorded_at"]);
        expect(TABLE_RETENTION.prompt_texts?.tier).toBe("R");
      } finally {
        state.close();
      }
    }));
});
