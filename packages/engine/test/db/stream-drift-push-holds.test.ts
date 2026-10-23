// Migration 51 (DIPO-315): `ingest_cursors.drift_lines`, the stream drift count of one agent, and
// `claims.no_remote_at`, when a push of the claim's branch found no remote. Counting and the hold
// are tested in test/ingest/stream-drift.test.ts and test/story-pr/push-retry.test.ts.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { Migration } from "../../src/db/migrations";
import { streamDriftPushHolds } from "../../src/db/migrations/0051-stream-drift-push-holds";
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

const columns = (all: (sql: string) => { name: string }[], table: string) =>
  all(`select name from pragma_table_info('${table}')`).map((row) => row.name);

describe("the stream drift and push holds migration", () => {
  it("adds ingest_cursors.drift_lines (0 for existing cursors) and claims.no_remote_at", () =>
    withTempDir(async (dir) => {
      const version = streamDriftPushHolds.version;
      const old = await open(
        dir,
        MIGRATIONS.filter((step) => step.version < version),
      );
      try {
        const all = (sql: string) => old.connection.all<{ name: string }>(sql);
        expect(columns(all, "ingest_cursors")).not.toContain("drift_lines");
        expect(columns(all, "claims")).not.toContain("no_remote_at");
      } finally {
        old.close();
      }

      const state = await open(dir);
      try {
        const all = (sql: string) => state.connection.all<{ name: string }>(sql);
        expect(MIGRATIONS.find((step) => step.version === version)?.name).toBe(
          "stream drift and push holds",
        );
        expect(columns(all, "ingest_cursors")).toContain("drift_lines");
        expect(columns(all, "claims")).toContain("no_remote_at");
        expect(
          state.connection.get<{ dflt_value: string }>(
            "select dflt_value from pragma_table_info('ingest_cursors') where name = 'drift_lines'",
          )?.dflt_value,
        ).toBe("0");
      } finally {
        state.close();
      }
    }));
});
