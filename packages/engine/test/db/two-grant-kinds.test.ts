// Migration 58 (DIPO-345): `run_grants` keeps two kinds, `budget` and `round`, the counted kinds
// map to a `round` grant naming its cap, `reviewCap` and `scope` grants go, and
// `runs.review_allowance` becomes the reviewer's token cap `review_max_tokens`.

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

/** Every grant kind before migration 58, its amount, and the row it becomes (null: dropped). */
const CASES: readonly (readonly [kind: string, amount: string, after: unknown])[] = [
  [
    "budget",
    '{"tokens":100,"turns":2,"minutes":3}',
    { kind: "budget", amount: { tokens: 100, turns: 2, minutes: 3 } },
  ],
  ["loop", "1", { kind: "round", amount: { cap: "loops", count: 1 } }],
  ["reviewRound", "2", { kind: "round", amount: { cap: "reviewRounds", count: 2 } }],
  ["ciAttempt", "1", { kind: "round", amount: { cap: "ciAttempts", count: 1 } }],
  ["conflictHandoff", "1", { kind: "round", amount: { cap: "conflictAttempts", count: 1 } }],
  ["reviewCap", '{"turns":20,"minutes":0}', null],
  ["scope", '["src/"]', null],
];

describe("migration 58 (DIPO-345)", () => {
  it("maps the counted grants to round grants, drops the rest and renames the review allowance", () =>
    withTempDir(async (dir) => {
      const before = MIGRATIONS.filter((step) => step.version <= 57);
      expect(before.at(-1)?.version).toBe(57);
      const old = await open(dir, before);
      try {
        const db = old.connection;
        db.immediate(() => {
          db.exec(`insert into offices (office_id, path, display_name, added_at, epoch, next_seq,
              replay_floor_seq) values ('off-1', '/repo', 'repo', 0, 'e', 1, 0);
            insert into runs (office_id, run_id, kind, role, model, budget_unit, budget_limit,
              loop_cap, config_hash, started_at, review_allowance)
            values ('off-1', 'run-1', 'session', 'developer', 'sonnet', 'tokens', 1, 3, 'h', 0,
              200000)`);
          CASES.forEach(([kind, amount], index) => {
            db.run(
              `insert into run_grants (office_id, run_id, grant_id, kind, amount, note, origin,
                 client, at)
               values ('off-1', 'run-1', $id, $kind, $amount, 'why', 'maintainer', null, $at)`,
              { id: `grt_${index}`, kind, amount, at: index },
            );
          });
        });
      } finally {
        old.close();
      }
      const migrated = await open(dir);
      try {
        const db = migrated.connection;
        const rows = db
          .all<{ kind: string; amount: string; note: string }>(
            "select kind, amount, note from run_grants order by at",
          )
          .map((row): unknown => ({ kind: row.kind, amount: JSON.parse(row.amount) as unknown }));
        expect(rows).toEqual(CASES.map(([, , after]) => after).filter((row) => row !== null));
        expect(
          db.get<{ review_max_tokens: number }>(
            "select review_max_tokens from runs where run_id = 'run-1'",
          ),
        ).toEqual({ review_max_tokens: 200_000 });
        expect(
          db
            .all<{ name: string }>("select name from pragma_table_info('runs')")
            .map((row) => row.name),
        ).not.toContain("review_allowance");
        // Only the two kinds can be written from now on.
        expect(() =>
          db.immediate(() =>
            db.exec(`insert into run_grants (office_id, run_id, grant_id, kind, amount, origin, at)
              values ('off-1', 'run-1', 'grt_x', 'reviewCap', '{}', 'maintainer', 9)`),
          ),
        ).toThrow();
      } finally {
        migrated.close();
      }
    }));
});
