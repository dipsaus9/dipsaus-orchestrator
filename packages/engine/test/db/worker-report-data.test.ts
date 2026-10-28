// Migration 43 (DIPO-186): the worker report's data. A fresh database and one migrated from
// version 42 have the same four tables, the retention policy lists each with tier S, and the
// stored rows survive closing and opening the database again, as at a daemon restart.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { RunId, StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { openStateDatabase } from "../../src/db/database";
import type { OfficeHandle } from "../../src/db/office";
import { MIGRATIONS } from "../../src/db/schema";
import { TABLE_RETENTION } from "../../src/retention/policy";
import { insertRun } from "../../src/run";
import {
  latestDoneReport,
  recordSendBack,
  sentBack,
  storeDecisionNotes,
  storeDoneReport,
  storeProposals,
} from "../../src/run/report-data";
import { addStory } from "../../src/stories/keys";
import { openDecisionNotes, openProposals, proposalItems } from "../../src/views/proposals";
import { addOffice, openTestState } from "../commands/helpers";
import { localMounts, memoryLogger } from "./helpers";

const TABLES = ["done_reports", "report_sendbacks", "decision_notes", "proposals"] as const;
const RUN = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");

type Db = { all<T>(sql: string): T[] };

function shape(db: Db, table: string) {
  return {
    columns: db
      .all<{ name: string; type: string; notnull: number; pk: number }>(
        `select name, type, "notnull", pk from pragma_table_info('${table}')`,
      )
      .map((c) => [c.name, c.type, c.notnull, c.pk]),
    sql: db.all<{ sql: string }>(
      `select sql from sqlite_master where tbl_name = '${table}' order by name`,
    ),
  };
}

/** A story and its run in `office`, for rows that name them. */
function storyRun(office: OfficeHandle, t: Awaited<ReturnType<typeof openTestState>>): StoryKey {
  const { key } = office.immediate(() =>
    addStory(office, t.ids, { story: StoryId.parse("DIPO-7") }, t.clock.now()),
  );
  office.immediate(() =>
    insertRun(office, {
      runId: RUN,
      kind: "story",
      key,
      story: "DIPO-7",
      tier: "S",
      role: "developer",
      model: "haiku",
      startSha: "b".repeat(40),
      branch: "DIPO-7/a-story",
      budgetUnit: "tokens",
      budgetLimit: 300_000,
      loopCap: 3,
      reviewRoundCap: 3,
      ciCap: 2,
      configHash: "h",
      overrideKeys: null,
      runProfileId: null,
      startedAt: t.clock.now(),
      scope: ["src/"],
    }),
  );
  return key;
}

describe("migration 43", () => {
  it("gives a fresh and a migrated database the same four tables", () =>
    withTempDir(async (dir) => {
      const open = (name: string, migrations?: typeof MIGRATIONS) =>
        openStateDatabase({
          stateDir: join(dir, name),
          logger: memoryLogger(),
          readMounts: localMounts,
          clock: new ManualClock(),
          engineVersion: "0.0.0-test",
          ...(migrations === undefined ? {} : { migrations }),
        });
      const old = await open(
        "migrated",
        MIGRATIONS.filter((step) => step.version <= 42),
      );
      try {
        for (const table of TABLES) {
          expect(
            old.connection.all(`select name from sqlite_master where name = '${table}'`),
          ).toEqual([]);
        }
      } finally {
        old.close();
      }
      const migrated = await open("migrated");
      const fresh = await open("fresh");
      try {
        expect(MIGRATIONS.find((step) => step.version === 43)?.name).toBe("worker report data");
        for (const table of TABLES) {
          expect(shape(migrated.connection, table)).toEqual(shape(fresh.connection, table));
          expect(shape(fresh.connection, table).columns.length).toBeGreaterThan(0);
        }
        expect(shape(fresh.connection, "decision_notes").columns.map(([name]) => name)).toEqual([
          "office_id",
          "hash",
          "story_key",
          "run_id",
          "file",
          "section",
          "text",
          "state",
          "created_at",
          "updated_at",
        ]);
        expect(shape(fresh.connection, "proposals").columns.map(([name]) => name)).toEqual([
          "office_id",
          "hash",
          "story_key",
          "run_id",
          "kind",
          "title",
          "outcome",
          "why",
          "paths",
          "state",
          "created_at",
          "updated_at",
          // Migration 49 (DIPO-166): the maintainer's decision.
          "decided_by",
          "draft_id",
        ]);
      } finally {
        migrated.close();
        fresh.close();
      }
    }));

  it("lists each table in the retention policy with tier S", () => {
    for (const table of TABLES) expect(TABLE_RETENTION[table]?.tier).toBe("S");
    expect(TABLE_RETENTION["proposals"]?.rule).toContain("an open proposal is kept");
    expect(TABLE_RETENTION["decision_notes"]?.rule).toContain("an open note is kept");
  });

  it("stores done reports, proposals, decision notes and send-back marks that survive a restart", () =>
    withTempDir(async (dir) => {
      const t = await openTestState(dir);
      let officeId: string;
      try {
        const office = addOffice(t);
        officeId = office.officeId;
        const key = storyRun(office, t);
        const at = t.clock.now();
        office.immediate(() => {
          expect(
            storeDoneReport(office, RUN, {
              testPlan: [{ n: 1, status: "not-done", evidence: "later" }],
              at,
            }),
          ).toBe(1);
          expect(
            storeDoneReport(office, RUN, {
              testPlan: [{ n: 1, status: "done", evidence: "test/a.test.ts" }],
              deviations: [{ where: "criterion #1", what: "w", why: "y" }],
              at: at + 1,
            }),
          ).toBe(2);
          const proposal = {
            kind: "follow-up",
            title: "Split it",
            outcome: "Two modules.",
            why: "It grew.",
            paths: ["src/b.ts", "src/a.ts"],
          } as const;
          expect(storeProposals(office, { key, runId: RUN, proposals: [proposal], at })).toBe(1);
          // The same title and paths, in another order and from a later report: one row.
          expect(
            storeProposals(office, {
              key,
              runId: RUN,
              proposals: [{ ...proposal, why: "Still.", paths: ["src/a.ts", "src/b.ts"] }],
              at: at + 5,
            }),
          ).toBe(0);
          // Another title, or other paths, is another proposal.
          expect(
            storeProposals(office, {
              key,
              runId: RUN,
              proposals: [
                { ...proposal, kind: "spike", title: "Ask why" },
                { ...proposal, paths: ["src/a.ts"] },
              ],
              at: at + 6,
            }),
          ).toBe(2);
          const note = {
            file: "docs/decisions/0008-worker-adapter.md",
            section: "1. The port",
            text: "A note.",
          };
          expect(storeDecisionNotes(office, { key, runId: RUN, notes: [note], at })).toBe(1);
          expect(storeDecisionNotes(office, { key, runId: RUN, notes: [note], at: at + 1 })).toBe(
            0,
          );
          recordSendBack(office, RUN, "decision-note", "note", at);
          recordSendBack(office, RUN, "decision-note", "note", at + 1);
        });
      } finally {
        t.state.close();
      }

      // Open the same state again, as a restarted daemon does.
      const again = await openStateDatabase({
        stateDir: join(dir, "state"),
        logger: memoryLogger(),
        readMounts: localMounts,
        clock: new ManualClock(),
        engineVersion: "0.0.0-test",
      });
      try {
        const office = again.office(officeId as never);
        expect(latestDoneReport(office, RUN)).toEqual({
          report: 2,
          testPlan: [{ n: 1, status: "done", evidence: "test/a.test.ts" }],
          deviations: [{ where: "criterion #1", what: "w", why: "y" }],
          at: expect.any(Number),
        });
        expect(sentBack(office, RUN, "decision-note", "note")).toBe(true);
        expect(sentBack(office, RUN, "decision-note", "run")).toBe(false);
        expect(openProposals(office).map((item) => [item.kind, item.title, item.story])).toEqual([
          ["follow-up", "Split it", "DIPO-7"],
          ["spike", "Ask why", "DIPO-7"],
          ["follow-up", "Split it", "DIPO-7"],
        ]);
        expect(openProposals(office)[0]?.detail).toBe(
          "Two modules. Why: It grew. Paths: src/b.ts, src/a.ts",
        );
        expect(openDecisionNotes(office)).toEqual([
          expect.objectContaining({
            kind: "decision-note",
            story: "DIPO-7",
            run: RUN,
            title: "Decision note for docs/decisions/0008-worker-adapter.md",
            detail: 'docs/decisions/0008-worker-adapter.md, section "1. The port": A note.',
          }),
        ]);
        expect(proposalItems(office)).toHaveLength(4);
        // A decided item leaves the open lists; the row stays for retention to age.
        office.immediate(() =>
          office.run("update proposals set state = 'dismissed' where office_id = $office_id"),
        );
        expect(openProposals(office)).toEqual([]);
        expect(proposalItems(office).map((item) => item.kind)).toEqual(["decision-note"]);
      } finally {
        again.close();
      }
    }));
});
