// Migration 3 (DIPO-452): the worker proposals still open on the desk when ideas land are held as
// ideas of their run and story, and audited once; a dismissed or accepted proposal is not.
// Migration 6 (DIPO-454) then drops the proposals table: a proposal is an idea only.

import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { OfficeId, RunId, type StoryKey } from "@dipsaus-orchestrator/contract";
import { ManualClock, withTempDir } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import { openStateDatabase } from "../../src/db/database";
import { ideaIdOf, proposalIdeaText } from "../../src/db/idea-ids";
import { MIGRATIONS } from "../../src/db/schema";
import { ideaViews, openPassedIdeas } from "../../src/records/ideas";
import { auditRef, type AuditSessionRequest, IdeaAudits } from "../../src/run/idea-audits";
import { hasTable } from "../../src/records/open-feedback";
import { storeProposals } from "../../src/run/report-data";
import { localMounts, memoryLogger } from "./helpers";

const OFFICE = OfficeId.parse("off_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");
const RUN = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");
const KEY = "sto_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D" as StoryKey;
const STORY_LINE =
  "As maintainer I want the pull request poll to back off after a failed read so that a dead host is not hammered";

function options(dir: string, migrations: typeof MIGRATIONS, clock: ManualClock) {
  return {
    stateDir: join(dir, "state"),
    logger: memoryLogger(),
    readMounts: localMounts,
    clock,
    engineVersion: "0.0.0-test",
    migrations,
  };
}

const H1 = "h1";

const proposalRow = (hash: string, title: string, state: string) => ({
  hash,
  title,
  state,
  story_line: STORY_LINE,
  why: "It hurts.",
  paths: JSON.stringify(["src/poll.ts"]),
});

describe("the open worker proposals at the upgrade (DIPO-452)", () => {
  it("are held as ideas and audited once, and the proposals table goes", () =>
    withTempDir(async (dir) => {
      const clock = new ManualClock();
      const before = await openStateDatabase(options(dir, MIGRATIONS.slice(0, 2), clock));
      try {
        const db = before.connection;
        db.immediate(() => {
          db.run(
            `insert into offices (office_id, path, display_name, added_at, next_seq)
             values ($office, '/repos/demo', 'demo', 0, 1)`,
            { office: OFFICE },
          );
          for (const row of [
            proposalRow(H1, "Cap the PR poll retry", "open"),
            proposalRow("h2", "Back off the fetch", "dismissed"),
            proposalRow("h3", "Show the spend", "accepted"),
          ]) {
            db.run(
              `insert into proposals (office_id, hash, story_key, run_id, kind, title, story_line,
                 why, paths, state, created_at, updated_at)
               values ($office, $hash, $key, $run, 'follow-up', $title, $story_line, $why, $paths,
                 $state, 5, 5)`,
              { office: OFFICE, key: KEY, run: RUN, ...row },
            );
          }
        });
      } finally {
        before.close();
      }

      const middle = await openStateDatabase(options(dir, MIGRATIONS.slice(0, 5), clock));
      try {
        const office = middle.office(OFFICE);
        expect(
          office.all<{ hash: string; state: string }>(
            "select hash, state from proposals where office_id = $office_id order by hash",
          ),
        ).toEqual([
          { hash: H1, state: "open" },
          { hash: "h2", state: "dismissed" },
          { hash: "h3", state: "accepted" },
        ]);
      } finally {
        middle.close();
      }

      const state = await openStateDatabase(options(dir, MIGRATIONS, clock));
      try {
        const office = state.office(OFFICE);
        const text = proposalIdeaText(STORY_LINE, "It hurts.", ["src/poll.ts"]);
        expect(ideaViews(office)).toEqual([
          {
            id: ideaIdOf("proposal", RUN, "Cap the PR poll retry", text),
            origin: "proposal",
            run: RUN,
            title: "Cap the PR poll retry",
            text,
            state: "held",
            attempts: 0,
            createdAt: new Date(5).toISOString(),
          },
        ]);
        expect(hasTable(office, "proposals")).toBe(false);
        // The worker's same proposal stored again by the live path is the same idea.
        office.immediate(() =>
          storeProposals(office, {
            key: KEY,
            runId: RUN,
            proposals: [
              {
                kind: "follow-up",
                title: "Cap the PR poll retry",
                story: STORY_LINE,
                why: "It hurts.",
                paths: ["src/poll.ts"],
              },
            ],
            at: 6,
          }),
        );
        expect(ideaViews(office)).toHaveLength(1);

        const requests: AuditSessionRequest[] = [];
        const audits = new IdeaAudits({
          clock,
          offices: { get: () => office, config: () => OFFICE_DEFAULTS },
          runner: () => ({
            run: async (request) => {
              requests.push(request);
              return {
                kind: "answered",
                runId: "run_01J9ZK5Q8W3V4X6Y7Z8A9B0AUD",
                answer: {
                  ideas: request.ideas.map((idea) => ({
                    idea: auditRef(idea),
                    verdict: "reject",
                    reason: "DIPO-30 covers it.",
                  })),
                },
              };
            },
          }),
        });
        // At the daemon's start, and again: audited once.
        audits.retryAll([OFFICE]);
        await audits.idle();
        audits.retryAll([OFFICE]);
        audits.poke(OFFICE);
        await audits.idle();
        expect(requests.map((request) => request.ideas.map((idea) => idea.title))).toEqual([
          ["Cap the PR poll retry"],
        ]);
        expect(ideaViews(office).map((idea) => [idea.state, idea.reason])).toEqual([
          ["rejected", "DIPO-30 covers it."],
        ]);
      } finally {
        state.close();
      }
    }));
});

/** Inserts a proposals row of the office, as a dipo before migration 6 did. */
const insertProposal = (
  db: Awaited<ReturnType<typeof openStateDatabase>>["connection"],
  row: ReturnType<typeof proposalRow>,
) =>
  db.run(
    `insert into proposals (office_id, hash, story_key, run_id, kind, title, story_line,
       why, paths, state, created_at, updated_at)
     values ($office, $hash, $key, $run, 'follow-up', $title, $story_line, $why, $paths,
       $state, 5, 5)`,
    { office: OFFICE, key: KEY, run: RUN, ...row },
  );

describe("the answered worker proposals at migration 6 (DIPO-454)", () => {
  it("keep the maintainer's answer on their idea, so neither comes back on the desk", () =>
    withTempDir(async (dir) => {
      const clock = new ManualClock();
      // Version 2: two open proposals, which migration 3 holds as ideas.
      const v2 = await openStateDatabase(options(dir, MIGRATIONS.slice(0, 2), clock));
      try {
        const db = v2.connection;
        db.immediate(() => {
          db.run(
            `insert into offices (office_id, path, display_name, added_at, next_seq)
             values ($office, '/repos/demo', 'demo', 0, 1)`,
            { office: OFFICE },
          );
          insertProposal(db, proposalRow("h1", "Cap the PR poll retry", "open"));
          insertProposal(db, proposalRow("h2", "Back off the fetch", "open"));
        });
      } finally {
        v2.close();
      }
      // Version 5: the ideas pass the audit, and the maintainer answers the proposals on the old
      // desk: one accepted as DRAFT-4, one dismissed.
      const v5 = await openStateDatabase(options(dir, MIGRATIONS.slice(0, 5), clock));
      try {
        const db = v5.connection;
        db.immediate(() => {
          db.run(
            `update ideas set state = 'passed', decided_by = 'audit', proposal = '{}', decided_at = 6`,
          );
          db.run(
            "update proposals set state = 'accepted', draft_id = 'DRAFT-4', updated_at = 7 where hash = 'h1'",
          );
          db.run("update proposals set state = 'dismissed', updated_at = 8 where hash = 'h2'");
        });
      } finally {
        v5.close();
      }

      const state = await openStateDatabase(options(dir, MIGRATIONS, clock));
      try {
        const office = state.office(OFFICE);
        expect(
          ideaViews(office).map((idea) => [idea.title, idea.answer, idea.answeredAt, idea.draft]),
        ).toEqual([
          ["Cap the PR poll retry", "accepted", new Date(7).toISOString(), "DRAFT-4"],
          ["Back off the fetch", "dismissed", new Date(8).toISOString(), undefined],
        ]);
        expect(openPassedIdeas(office)).toEqual([]);
        expect(hasTable(office, "proposals")).toBe(false);
      } finally {
        state.close();
      }
    }));
});
