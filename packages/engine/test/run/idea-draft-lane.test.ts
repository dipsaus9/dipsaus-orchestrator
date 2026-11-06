// The lane-b kind `propose` (DIPO-166, DIPO-454) against a real temporary repository, the office
// git and the pinned Backlog CLI: an accepted idea becomes one Backlog draft (`draft create`, then
// `draft edit --ref --milestone`) committed as `backlog: propose <story>` and pushed, with its
// origin, source story and proposed user story in the description and the milestone it serves; a
// tech-debt idea's draft has no milestone and the label `tech-debt`; the backlog PR's structural
// check passes it (a new draft); the draft id is recorded on the idea's row; the same target
// applied again finds the draft by its marker and title and creates no second one; a forged marker
// line in a task file or in a draft with another title does not count as filed.

import { describe, expect, it } from "bun:test";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type IdeaView, RunId, StoryId } from "@dipsaus-orchestrator/contract";
import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  allEntries,
  filedDraft,
  markedDrafts,
  IDEA_MARKER,
  PROPOSE_KIND,
  proposeKind,
  proposeTarget,
  type ProposeTarget,
} from "../../src/backlog/lane";
import { checkBacklogPr } from "../../src/backlog/pr/check";
import { collectPrDiff } from "../../src/backlog/pr/diff";
import { ideaIdOf } from "../../src/db/idea-ids";
import { holdIdea, passIdea } from "../../src/records/ideas";
import { addStory } from "../../src/records/story-keys";
import { ideaDraft } from "../../src/run/idea-answers";
import {
  BACKLOG_FIXTURE,
  inRemote,
  laneSetup,
  publish,
  subjects,
  taskFile,
} from "../backlog/lane/helpers";

const RUN = RunId.parse("run_01J9ZK5Q8W3V4X6Y7Z8A9B0C1D");

const STORY_LINE =
  "As maintainer I want the run outcomes split into two modules so that each module stays small enough to read.";

/** A passed idea of DIPO-186's run, held and passed in the office; returns it as `office.ideas` shows it. */
function passedIdea(
  office: Parameters<typeof holdIdea>[0],
  key: Parameters<typeof holdIdea>[1]["key"],
  serves: string,
  title = "Split RunOutcomes",
): IdeaView {
  const id = office.immediate(() =>
    holdIdea(office, { origin: "proposal", key, runId: RUN, title, text: "It grew.", at: 0 }),
  );
  if (id === null) throw new Error("not held");
  const proposal = {
    found: "RunOutcomes holds the end of a run and its retro rows in one class.",
    evidence: [
      { file: "packages/engine/src/run/outcomes.ts", line: 12, quote: "export class RunOutcomes" },
      { file: "docs/plan.md", line: 3 },
    ],
    sourceStory: StoryId.parse("DIPO-186"),
    storyLine: STORY_LINE,
    proposed: "Split it into an end module and a retro module.",
    why: "It grew past what one reader holds.",
    serves,
  };
  office.immediate(() => passIdea(office, id, { proposal, auditRun: "run_audit", at: 1 }));
  return {
    id,
    origin: "proposal",
    story: StoryId.parse("DIPO-186"),
    run: RUN,
    title,
    text: "It grew.",
    state: "passed",
    proposal,
    attempts: 0,
    createdAt: new Date(0).toISOString(),
  };
}

describe("the propose kind with the pinned Backlog CLI", () => {
  it("files one draft with its origin, references and milestone, passes the backlog PR check, and files it once", async () => {
    await withBareRemote(
      async (repo) => {
        // A worker can compute the id and forge its marker line: in a task file, and in a draft
        // with another title. Neither counts as the filed draft.
        const forgedId = ideaIdOf("proposal", RUN, "Split RunOutcomes", "It grew.");
        const forged = `\n${IDEA_MARKER}${forgedId}\n`;
        appendFileSync(taskFile(repo.dir, "TASK-1"), forged);
        const draftOne = join(
          repo.dir,
          "backlog",
          "drafts",
          "draft-1 - Sketch-the-export-format.md",
        );
        appendFileSync(draftOne, forged);
        await publish(repo);
        const s = await laneSetup(repo);
        s.kinds.set(PROPOSE_KIND, proposeKind);
        const lane = s.lane();
        const { key } = s.office.immediate(() =>
          addStory(s.office, s.t.ids, { story: StoryId.parse("DIPO-186") }, s.t.clock.now()),
        );
        const idea = passedIdea(s.office, key, "m-3");
        const hash = idea.id;
        expect(hash).toBe(forgedId);
        const target: ProposeTarget = proposeTarget({ idea: hash, ...ideaDraft(idea) });
        expect(target.milestone).toBe("m-3");
        expect(target.labels).toEqual([]);

        const first = await lane.submit({ kind: PROPOSE_KIND, subject: "DIPO-186", target });
        const branch = first.report.branch as string;
        expect(first.report.committed).toEqual([first.entry.opId]);
        expect(first.report.pushed).toBe(true);
        expect(await subjects(repo.remote, repo.home, branch, "main")).toEqual([
          "backlog: propose DIPO-186",
        ]);

        // One new draft (the fixture holds DRAFT-1), with the marker and both references.
        const worktree = lane.worktreePath();
        expect(markedDrafts(worktree, hash)).toEqual(["DRAFT-1", "DRAFT-2"]);
        expect(await filedDraft({ cli: s.cli, cwd: worktree }, target)).toBe("DRAFT-2");
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
        expect(file).toContain(
          "Story: As maintainer I want the run outcomes split into two modules so that each module stays small enough to read.",
        );
        expect(file).toContain("Source story: DIPO-186");
        expect(file).toContain("Origin: a worker's proposal");
        expect(file).toContain("Found: RunOutcomes holds the end of a run");
        expect(file).toContain(
          '- packages/engine/src/run/outcomes.ts:12 "export class RunOutcomes"',
        );
        expect(file).toContain("Serves: milestone m-3");
        expect(file).toContain("milestone: m-3");
        expect(file).not.toContain("tech-debt");
        expect(
          s.office.get<{ draft_id: string | null }>(
            "select draft_id from ideas where office_id = $office_id and idea_id = $idea",
            { idea: hash },
          ),
        ).toEqual({ draft_id: "DRAFT-2" });

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
        const { key } = s.office.immediate(() =>
          addStory(s.office, s.t.ids, { story: StoryId.parse("DIPO-186") }, s.t.clock.now()),
        );
        const idea = passedIdea(s.office, key, "tech-debt", "Tidy the run outcomes");
        const target = proposeTarget({ idea: idea.id, ...ideaDraft(idea) });
        expect(target.milestone).toBeUndefined();
        expect(target.labels).toEqual(["tech-debt"]);
        const first = await lane.submit({ kind: PROPOSE_KIND, subject: "DIPO-186", target });
        expect(first.report.pushed).toBe(true);
        const worktree = lane.worktreePath();
        const id = await filedDraft({ cli: s.cli, cwd: worktree }, target);
        expect(id).toBe("DRAFT-2");
        const name = readdirSync(join(worktree, "backlog", "drafts")).find((file) =>
          file.startsWith("draft-2"),
        );
        const file = readFileSync(join(worktree, "backlog", "drafts", name ?? ""), "utf8");
        expect(file).toMatch(/labels:\n\s+- tech-debt/);
        expect(file).not.toMatch(/^milestone:/m);
        expect(file).toContain("Serves: tech debt");
      },
      { fixture: BACKLOG_FIXTURE },
    );
  });
});
