// Migration 59 (DIPO-361): the steer, held-feedback and report-feedback intents become the one
// feedback tag, `feedback <source> <key> <text>`, with the text the worker reads; every other
// intent is left alone.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { MIGRATIONS } from "../../src/db/schema";
import { reportFeedbackText } from "../../src/run/outcome-types";
import { steerText } from "../../src/run/intervene";
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

/** Each intent before migration 59, as kind and detail, and the detail it becomes. */
const CASES: readonly (readonly [kind: string, before: string, after: string])[] = [
  [
    "steer",
    "maintainer-steer 01JREQ Use bun, not npm.",
    `feedback steer 01JREQ ${steerText("Use bun, not npm.")}`,
  ],
  ["steer", "maintainer-steer 01JREQ2", "feedback steer 01JREQ2 The maintainer says: "],
  [
    "steer",
    "held-feedback Note from the maintainer: go on.",
    "feedback resume - Note from the maintainer: go on.",
  ],
  [
    "steer",
    "report-feedback agt_1 no structured_output",
    `feedback report agt_1 ${reportFeedbackText("no structured_output")}`,
  ],
  ["steer", 'fix-round {"head":"abc","advisories":[]}', 'fix-round {"head":"abc","advisories":[]}'],
  ["steer", "verify feedback", "verify feedback"],
  ["park", "maintainer-steer looks alike", "maintainer-steer looks alike"],
];

describe("migration 59 (DIPO-361)", () => {
  it("rewrites the three old tags to the one feedback tag and leaves the rest", () =>
    withTempDir(async (dir) => {
      const before = MIGRATIONS.filter((step) => step.version <= 58);
      expect(before.at(-1)?.version).toBe(58);
      const old = await open(dir, before);
      try {
        const db = old.connection;
        db.immediate(() => {
          db.exec(`insert into offices (office_id, path, display_name, added_at, epoch, next_seq,
              replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
              loop_cap, config_hash, started_at)
            values ('off-1', 'run-1', 'session', 'developer', 'sonnet', 'tokens', 1, 3, 'h', 0)`);
          CASES.forEach(([kind, detail], index) => {
            db.run(
              `insert into run_intents (office_id, run_id, intent_id, kind, detail, state, created_at)
               values ('off-1', 'run-1', $id, $kind, $detail, 'pending', $id)`,
              { id: index + 1, kind, detail },
            );
          });
        });
      } finally {
        old.close();
      }
      const migrated = await open(dir);
      try {
        const rows = migrated.connection.all<{ detail: string }>(
          "select detail from run_intents order by intent_id",
        );
        expect(rows.map((row) => row.detail)).toEqual(CASES.map(([, , after]) => after));
      } finally {
        migrated.close();
      }
    }));
});
