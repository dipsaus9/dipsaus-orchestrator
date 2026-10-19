// Migration 35 (DIPO-202): `usage_messages.output_state`, backfilled to 1 for the messages of an
// agent that already had a turn end.

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

describe("migration 35 on a database at version 34", () => {
  it("marks the messages of an agent with a turn end as in the totals, the others as not", () =>
    withTempDir(async (dir) => {
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version <= 34),
      );
      try {
        old.connection.immediate(() => {
          old.connection.exec(`insert into offices (office_id, path, display_name, added_at, epoch,
            next_seq, replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0)`);
          old.connection.exec(`insert into runs (office_id, run_id, kind, role, model, budget_unit,
            budget_limit, loop_cap, config_hash, started_at)
            values ('off-1', 'r1', 'session', 'developer', 'haiku', 'tokens', 100, 1, 'cfg', 1)`);
          old.connection.exec(`insert into agents (office_id, agent_id, run_id, role, model,
            adapter_version, started_at)
            values ('off-1', 'a-ended', 'r1', 'developer', 'haiku', '2.1.296', 1),
              ('off-1', 'a-open', 'r1', 'developer', 'haiku', '2.1.296', 1)`);
          old.connection.exec(`insert into usage_messages (office_id, agent_id, message_id, run_id,
            model, input, output, cache_create, cache_create_5m, cache_create_1h, cache_read, at)
            values ('off-1', 'a-ended', 'm1', 'r1', 'haiku', 1, 5, 0, 0, 0, 0, 1),
              ('off-1', 'a-open', 'm2', 'r1', 'haiku', 1, 5, 0, 0, 0, 0, 1)`);
          old.connection.exec(`insert into usage_totals (office_id, run_id, agent_id, model, role,
            tier, budget_limit, turns, updated_at)
            values ('off-1', 'r1', 'a-ended', 'haiku', 'developer', 'M', 100, 1, 1),
              ('off-1', 'r1', 'a-open', 'haiku', 'developer', 'M', 100, 0, 1)`);
        });
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        expect(MIGRATIONS.find((step) => step.version === 35)?.name).toBe(
          "usage message output state",
        );
        expect(
          state.connection.all(
            "select message_id, output_state from usage_messages order by message_id",
          ),
        ).toEqual([
          { message_id: "m1", output_state: 1 },
          { message_id: "m2", output_state: 0 },
        ]);
      } finally {
        state.close();
      }
    }));
});
