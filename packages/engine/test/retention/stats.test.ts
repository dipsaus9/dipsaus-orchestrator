// `office.stats` (DIPO-65; 0007 "Size") and the retention policy of every office-scoped table.

import { describe, expect, it } from "bun:test";

import { RequestId } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { appendEntries } from "../../src/changelog/log";
import { buildRegistry } from "../../src/commands/registry";
import { SOFTWARE_TABLES } from "../../src/db/schema";
import { FEATURES } from "../../src/features";
import { TABLE_RETENTION } from "../../src/retention/policy";
import { officeTables, statsFeature, tableStats } from "../../src/retention/stats";
import { addOffice, openTestState } from "../commands/helpers";

import { insertAgent, insertRequests } from "./helpers";

function allOfficeTables(t: Awaited<ReturnType<typeof openTestState>>): string[] {
  return t.state.connection
    .all<{ name: string }>(
      "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .map((row) => row.name)
    .filter((name) => !SOFTWARE_TABLES.has(name));
}

describe("office.stats", () => {
  it("returns a row count for every office-scoped table of the office", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t, "one");
        const other = addOffice(t, "two");
        insertRequests(office, 3, t.clock.now());
        insertRequests(other, 5, t.clock.now());
        insertAgent(office, { run: "run-a", agent: "agt-a", startedAt: 1, endedAt: 2 });
        office.immediate(() =>
          appendEntries(
            office,
            [{ type: "engine.notice", delta: { level: "info", code: "x", text: "a".repeat(500) } }],
            { at: t.clock.now() },
          ),
        );

        const stats = tableStats(office);
        expect(stats.map((row) => row.table)).toEqual(allOfficeTables(t));
        const byTable = new Map(stats.map((row) => [row.table, row]));
        expect(byTable.get("requests")?.rows).toBe(3);
        expect(byTable.get("change_log")?.rows).toBe(1);
        expect(byTable.get("change_log")?.bytes).toBeGreaterThan(500);
        for (const table of ["agents", "usage_messages", "usage_totals", "ingest_cursors"]) {
          expect(byTable.get(table)?.rows).toBe(1);
          expect(byTable.get(table)?.bytes).toBeGreaterThan(0);
        }
        expect(byTable.get("stories")).toEqual({ table: "stories", rows: 0, bytes: 0 });
        expect(tableStats(other).find((row) => row.table === "requests")?.rows).toBe(5);
      } finally {
        t.state.close();
      }
    }));

  it("is a registered read in the engine's features", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        expect(buildRegistry(FEATURES).read("office.stats")?.module).toBe(statsFeature.name);
        const read = buildRegistry([statsFeature]).read("office.stats");
        const result = read?.handle(
          {
            clock: new ManualClock(),
            requestId: RequestId.parse("01J9ZK5Q8W3V4X6Y7Z8A9B0C1D"),
            office,
            stories: new Map(),
            registry: buildRegistry([]),
          },
          { office: office.officeId },
        );
        expect(read?.definition.result.parse(result)).toEqual({
          office: office.officeId,
          tables: tableStats(office),
        });
      } finally {
        t.state.close();
      }
    }));
});

describe("retention policy", () => {
  it("names a tier for every office-scoped table, and only for those", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      try {
        const office = addOffice(t);
        expect(officeTables(office)).toEqual(allOfficeTables(t));
        // A new office-scoped table needs a line in retention/policy.ts (0007 section 7).
        expect(allOfficeTables(t)).toEqual(Object.keys(TABLE_RETENTION).toSorted());
      } finally {
        t.state.close();
      }
    }));
});
