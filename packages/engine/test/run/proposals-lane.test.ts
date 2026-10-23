// The lane-b kind `propose` (DIPO-166) against a real temporary repository, the office git and the
// pinned Backlog CLI: an accepted proposal becomes one Backlog draft (`draft create`, then
// `draft edit --ref`) committed as `backlog: propose <story>` and pushed; the backlog PR's
// structural check passes it (a new draft); the draft id is recorded on the proposal's row; the
// same target applied again finds the draft by its marker and creates no second one.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  markedStory,
  PROPOSE_KIND,
  proposeKind,
  type ProposeTarget,
} from "../../src/backlog/lane";
import { checkBacklogPr } from "../../src/backlog/pr/check";
import { collectPrDiff } from "../../src/backlog/pr/diff";
import { proposalDraft } from "../../src/run/proposals";
import { proposalHash, storeProposals } from "../../src/run/report-data";
import { addStory } from "../../src/stories/keys";
import { BACKLOG_FIXTURE, inRemote, laneSetup, publish, subjects } from "../backlog/lane/helpers";

const RUN = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");

const PROPOSAL = {
  kind: "follow-up",
  title: "Split RunOutcomes",
  outcome: "RunOutcomes is two modules.",
  why: "It grew.",
  paths: ["packages/engine/src/run/outcomes.ts", "docs/plan.md"],
} as const;

describe("the propose kind with the pinned Backlog CLI", () => {
  it("files one draft with its references, passes the backlog PR check, and files it once", async () => {
    await withBareRemote(
      async (repo) => {
        await publish(repo);
        const s = await laneSetup(repo);
        s.kinds.set(PROPOSE_KIND, proposeKind);
        const lane = s.lane();
        const { key } = s.office.immediate(() =>
          addStory(s.office, s.t.ids, { story: StoryId.parse("DIPO-186") }, s.t.clock.now()),
        );
        s.office.immediate(() =>
          storeProposals(s.office, { key, runId: RUN, proposals: [PROPOSAL], at: 0 }),
        );
        const hash = proposalHash(PROPOSAL);
        const target: ProposeTarget = {
          proposal: hash,
          ...proposalDraft({
            hash,
            key,
            story: StoryId.parse("DIPO-186"),
            run: RUN,
            kind: PROPOSAL.kind,
            title: PROPOSAL.title,
            outcome: PROPOSAL.outcome,
            why: PROPOSAL.why,
            paths: PROPOSAL.paths,
            state: "accepted",
            draft: null,
          }),
        };

        const first = await lane.submit({ kind: PROPOSE_KIND, subject: "DIPO-186", target });
        const branch = first.report.branch as string;
        expect(first.report.committed).toEqual([first.entry.opId]);
        expect(first.report.pushed).toBe(true);
        expect(await subjects(repo.remote, repo.home, branch, "main")).toEqual([
          "backlog: propose DIPO-186",
        ]);

        // One new draft (the fixture holds DRAFT-1), with the marker and both references.
        const worktree = lane.worktreePath();
        expect(markedStory(worktree, hash)).toBe("DRAFT-2");
        const drafts = readdirSync(join(worktree, "backlog", "drafts")).toSorted();
        expect(drafts).toHaveLength(2);
        const file = readFileSync(
          join(
            worktree,
            "backlog",
            "drafts",
            drafts.find((name) => name.startsWith("draft-2")) ?? "",
          ),
          "utf8",
        );
        expect(file).toContain("title: Split RunOutcomes");
        expect(file).toContain("packages/engine/src/run/outcomes.ts");
        expect(file).toContain("docs/plan.md");
        expect(file).toContain("Outcome (the worker's words): RunOutcomes is two modules.");
        expect(file).toContain("Source story: DIPO-186");
        expect(
          s.office.get<{ draft_id: string | null }>(
            "select draft_id from proposals where office_id = $office_id and hash = $hash",
            {
              hash,
            },
          ),
        ).toEqual({ draft_id: "DRAFT-2" });

        // The backlog PR's structural check passes the new draft (0010 section 2).
        const base = (await inRemote(repo, "rev-parse", "main")).trim();
        const head = (await inRemote(repo, "rev-parse", branch)).trim();
        const diff = await s.git.run(async (git) => {
          const location = s.git.worktreeLocation(worktree);
          if (location.kind !== "worktree") throw new Error("expected the backlog worktree");
          return collectPrDiff({ git, worktree: location, cli: s.cli, base, head });
        });
        expect(checkBacklogPr(diff, { keys: {}, claimed: [], passing: {} })).toMatchObject({
          passed: true,
          failures: [],
        });

        // The same target again: the marker finds the draft, nothing new is committed.
        const again = await lane.submit({ kind: PROPOSE_KIND, subject: "DIPO-186", target });
        expect(again.report.committed).toEqual([]);
        expect(again.report.dropped).toEqual([again.entry.opId]);
        expect(readdirSync(join(worktree, "backlog", "drafts"))).toHaveLength(2);
        expect(allEntries(s.office).map((entry) => entry.state)).toEqual(["pushed", "dropped"]);
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
