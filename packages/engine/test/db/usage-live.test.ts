// Migration 42 (DIPO-296): `usage_totals` gains `live_turns` and `live_output`, the live numbers of
// an agent's turn in progress; the rows of a database at version 41 stay, with both at 0.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
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

describe("migration 42 on a database at version 41", () => {
  it("keeps the usage rows, with no live numbers, and refuses a negative one", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 41),
      );
      try {
        old.connection.immediate(() => {
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0)`);
          old.connection.exec(`insert into agents (office_id, agent_id, run_id, role, model,
            started_at) values ('off-1', 'agt-1', 'r1', 'developer', 'haiku', 1)`);
          old.connection.exec(`insert into usage_totals (office_id, run_id, agent_id, model, role,
            tier, output, turns, updated_at)
            values ('off-1', 'r1', 'agt-1', 'haiku', 'developer', 'S', 155, 2, 1)`);
        });
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        expect(MIGRATIONS.find((step) => step.version === 42)?.name).toBe("usage live numbers");
        expect(
          state.connection.all(
            "select output, turns, live_output, live_turns from usage_totals where run_id = 'r1'",
          ),
        ).toEqual([{ output: 155, turns: 2, live_output: 0, live_turns: 0 }]);
        expect(() =>
          state.connection.exec("update usage_totals set live_turns = -1 where run_id = 'r1'"),
        ).toThrow();
      } finally {
        state.close();
      }
    }));
});
