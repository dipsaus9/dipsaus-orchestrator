// The backlog PR against real temporary repositories, the pinned Backlog CLI and an in-memory code
// host (DIPO-35; 0010 section 2, lane b): a pushed engine branch opens one PR, a later operation
// updates the same PR, the PR is stored on the journal entries, and without a remote or a `gh` login
// no PR is opened and the waiting branch is reported. A failing PR kept open and its merge commit by
// hand run in CI only, in pr.ci.test.ts (DIPO-79); their fast rules are in check.test.ts and
// records.test.ts.

import { describe, expect, it } from "bun:test";

import { StoryId } from "@dipsaus-orchestrator/contract";
import { withBareRemote, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { allEntries } from "../../../src/backlog/lane";
import { backlogPrMergeable, findPr, PR_NOTICES, TITLE_PREFIX } from "../../../src/backlog/pr";
import { addStory } from "../../../src/stories/keys";
import { BACKLOG_FIXTURE, notices, publish } from "../lane/helpers";

import { laneSetup, prSetup, REPO } from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

describe("the backlog PR", () => {
  it("opens one PR once gh is logged in, updates it for the next operation and checks each head", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await prSetup(repo, await laneSetup(repo));
      const keys = {
        one: addStory(s.office, s.t.ids, { story: StoryId.parse("TASK-1") }, 0).key,
        two: addStory(s.office, s.t.ids, { story: StoryId.parse("TASK-2") }, 0).key,
      };

      // gh is not logged in: the branch is pushed, but no PR opens, and the branch waits.
      s.host.failWith = "unauthenticated";
      const first = await s.lane().submit({
        kind: "edit",
        key: keys.one,
        subject: "TASK-1",
        target: { status: "Refined" },
      });
      const branch = first.report.branch as string;
      expect(first.report.pushed).toBe(true);
      expect(s.host.prs.size).toBe(0);
      expect(s.prs.waiting(s.officeId)).toMatchObject({ branch, reason: "ghUnauthenticated" });
      expect(notices(s.office).filter((n) => n.code === PR_NOTICES.waiting)).toHaveLength(1);

      // Logged in: the next flush opens the PR for the branch already pushed, and checks it.
      s.host.failWith = null;
      await s.lane().flush();
      expect(s.prs.waiting(s.officeId)).toBeNull();
      expect([...s.host.prs.values()].map((pr) => [pr.head, pr.base, pr.title])).toEqual([
        [branch, "main", `${TITLE_PREFIX}edit TASK-1`],
      ]);
      const pr = findPr(s.office, 1);
      expect(pr).toMatchObject({ state: "open", check: "passed", branch });
      const tip = (await repo.git("rev-parse", branch)).trim();
      expect(pr?.checkedHead).toBe(tip);
      expect(backlogPrMergeable(s.office, 1, tip)).toBe(true);
      // The check left the backlog worktree on the branch, where the lane writes next.
      expect(
        (await repo.git("-C", s.lane().worktreePath(), "symbolic-ref", "--short", "HEAD")).trim(),
      ).toBe(branch);

      // A second operation appends to the branch and updates the same PR, which is checked again.
      await s.lane().submit({
        kind: "edit",
        key: keys.two,
        subject: "TASK-2",
        target: { labels: { add: ["tier:M"] } },
      });
      expect(s.host.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
      expect(s.host.prs.get(1)?.title).toBe(`${TITLE_PREFIX}edit TASK-1, edit TASK-2`);
      const newTip = (await repo.git("rev-parse", branch)).trim();
      expect(findPr(s.office, 1)).toMatchObject({ check: "passed", checkedHead: newTip });
      expect(backlogPrMergeable(s.office, 1, tip)).toBe(false);
      expect(backlogPrMergeable(s.office, 1, newTip)).toBe(true);
      // The PR is stored on every journal entry of the branch.
      expect(allEntries(s.office).map((entry) => entry.prRef)).toEqual([
        `https://github.com/${REPO}/pull/1`,
        `https://github.com/${REPO}/pull/1`,
      ]);
    }, FIXTURE);
  });
});

describe("without a remote", () => {
  it("opens no PR and reports the waiting branch", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await prSetup(null, await laneSetup(repo));
      const one = addStory(s.office, s.t.ids, { story: StoryId.parse("TASK-1") }, 0).key;
      const { report } = await s.lane().submit({
        kind: "edit",
        key: one,
        subject: "TASK-1",
        target: { status: "Refined" },
      });
      expect(report.waiting?.reason).toBe("noRemote");
      expect(s.prs.waiting(s.officeId)).toMatchObject({
        branch: report.branch,
        reason: "noRemote",
      });
      expect(s.host.calls).toEqual([]);
    }, FIXTURE);
  });
});
