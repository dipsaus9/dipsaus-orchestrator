// The lane-b kind `propose` (DIPO-166, DIPO-454) against a real temporary repository, the office
// git and the pinned Backlog CLI: an accepted idea becomes one Backlog draft (`draft create` with
// its labels, then `draft edit` for its milestone and references) committed as `backlog: propose
// <story>` and pushed; a draft of a milestone has it, a tech-debt draft has none and the label
// `tech-debt`; the backlog PR's structural check passes it (a new draft); the draft id is recorded
// on the idea's row; the same target applied again finds the draft by its marker and title and
// creates no second one; a forged marker line in a task file or in a draft with another title does
// not count as filed.

import { describe, expect, it } from "bun:test";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  filedDraft,
  markedDrafts,
  PROPOSAL_MARKER,
  PROPOSE_KIND,
  proposeKind,
  proposeTarget,
  type ProposeTarget,
} from "../../src/backlog/lane";
import { checkBacklogPr } from "../../src/backlog/pr/check";
import { collectPrDiff } from "../../src/backlog/pr/diff";
import { ideasByPrefix } from "../../src/records/ideas";
import { addStory } from "../../src/records/story-keys";
import { ideaDraft } from "../../src/run/proposals";
import {
  BACKLOG_FIXTURE,
  inRemote,
  laneSetup,
  publish,
  subjects,
  taskFile,
} from "../backlog/lane/helpers";
import { passedIdea } from "./idea-fixture";

const RUN = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");

/** The draft file of `id` in the worktree `dir`. */
function draftFile(dir: string, id: string): string {
  const drafts = join(dir, "backlog", "drafts");
  const name = readdirSync(drafts).find((file) => file.startsWith(`${id.toLowerCase()} - `));
  return name === undefined ? "" : readFileSync(join(drafts, name), "utf8");
}

describe("the propose kind with the pinned Backlog CLI", () => {
  it("files one draft of an accepted idea with its origin, milestone and references, passes the backlog PR check, and files it once", async () => {
    await withBareRemote(
      async (repo) => {
        const s = await laneSetup(repo);
        s.kinds.set(PROPOSE_KIND, proposeKind);
        const lane = s.lane();
        const { key } = s.office.immediate(() =>
          addStory(s.office, s.t.ids, { story: StoryId.parse("DIPO-186") }, s.t.clock.now()),
        );
        const id = passedIdea(s.office, {
          key,
          run: RUN,
          story: StoryId.parse("DIPO-186"),
          title: "Split RunOutcomes",
          at: 0,
          proposal: {
            evidence: [
              { file: "packages/engine/src/run/outcomes.ts", line: 12 },
              { file: "docs/plan.md", line: 3 },
            ],
          },
        });
        // A worker can compute the id and forge its marker line: in a task file, and in a draft
        // with another title. Neither counts as the filed draft.
        const forged = `\n${PROPOSAL_MARKER}${id}\n`;
        appendFileSync(taskFile(repo.dir, "TASK-1"), forged);
        appendFileSync(
          join(repo.dir, "backlog", "drafts", "draft-1 - Sketch-the-export-format.md"),
          forged,
        );
        await publish(repo);
        const [idea] = ideasByPrefix(s.office, id);
        const draft = idea === undefined ? null : ideaDraft(idea);
        if (draft === null) throw new Error("no draft");
        const target: ProposeTarget = proposeTarget({ proposal: id, ...draft });

        const first = await lane.submit({ kind: PROPOSE_KIND, subject: "DIPO-186", target });
        const branch = first.report.branch as string;
        expect(first.report.committed).toEqual([first.entry.opId]);
        expect(first.report.pushed).toBe(true);
        expect(await subjects(repo.remote, repo.home, branch, "main")).toEqual([
          "backlog: propose DIPO-186",
        ]);

        // One new draft (the fixture holds DRAFT-1), with the marker, its milestone, both
        // references, its origin and source story.
        const worktree = lane.worktreePath();
        expect(markedDrafts(worktree, id)).toEqual(["DRAFT-1", "DRAFT-2"]);
        expect(await filedDraft({ cli: s.cli, cwd: worktree }, target)).toBe("DRAFT-2");
        expect(readdirSync(join(worktree, "backlog", "drafts"))).toHaveLength(2);
        const file = draftFile(worktree, "DRAFT-2");
        expect(file).toContain("title: Split RunOutcomes");
        expect(file).toContain("milestone: m-3");
        expect(file).not.toContain("tech-debt");
        expect(file).toContain("packages/engine/src/run/outcomes.ts");
        expect(file).toContain("docs/plan.md");
        expect(file).toContain(
          "Story: As maintainer I want the PR poll to back off after a failed read so that a dead host is not hammered",
        );
        expect(file).toContain(`Origin: a worker's proposal of DIPO-186 (idea ${id.slice(0, 12)}`);
        expect(file).toContain("Source story: DIPO-186");
        expect(ideasByPrefix(s.office, id)[0]?.draft).toBe("DRAFT-2");

        // The backlog PR's structural check passes the new draft (0010).
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

  it("files a tech-debt idea as a draft with no milestone and the label tech-debt", async () => {
    await withBareRemote(
      async (repo) => {
        await publish(repo);
        const s = await laneSetup(repo);
        s.kinds.set(PROPOSE_KIND, proposeKind);
        const lane = s.lane();
        const id = passedIdea(s.office, {
          origin: "quick",
          title: "Cap the PR poll retry",
          at: 0,
          proposal: { serves: "tech-debt" },
        });
        const [idea] = ideasByPrefix(s.office, id);
        const draft = idea === undefined ? null : ideaDraft(idea);
        if (draft === null) throw new Error("no draft");
        const target = proposeTarget({ proposal: id, ...draft });
        const filed = await lane.submit({ kind: PROPOSE_KIND, subject: "an idea", target });
        expect(filed.report.committed).toEqual([filed.entry.opId]);
        const file = draftFile(lane.worktreePath(), "DRAFT-2");
        expect(file).toContain("title: Cap the PR poll retry");
        expect(file).toMatch(/labels:\n {2}- tech-debt\n/);
        expect(file).not.toContain("milestone: m-");
        expect(file).toContain("Serves: tech debt");
        expect(file).toContain("Origin: the maintainer's quick idea");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
