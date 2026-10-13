// The backlog PR against real temporary repositories, the pinned Backlog CLI and an in-memory code
// host (DIPO-35; 0010 section 2, lane b): a pushed engine branch opens one PR, a later operation
// updates the same PR, the PR is stored on the journal entries, a failing structural check keeps it
// open with a notice and not mergeable, a merge by hand is checked again and blocks the stories it
// fails on, and without a remote or a `gh` login no PR is opened and the waiting branch is reported.

import { describe, expect, it } from "bun:test";

import { StoryId } from "@dipsaus-orchestrator/contract";
import { withBareRemote, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { allEntries } from "../../../src/backlog/lane";
import {
  backlogCheckBlocked,
  backlogPrMergeable,
  findPr,
  PR_NOTICES,
  TITLE_PREFIX,
} from "../../../src/backlog/pr";
import { addStory } from "../../../src/stories/keys";
import { BACKLOG_FIXTURE, notices, publish } from "../lane/helpers";

import { laneSetup, mergeCommitOnRemote, prSetup, REPO } from "./helpers";

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

  it("keeps a failing PR open with a notice, and blocks its story after a merge commit by hand", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await prSetup(repo, await laneSetup(repo));
      const two = addStory(s.office, s.t.ids, { story: StoryId.parse("TASK-2") }, 0).key;

      // TASK-2 becomes Ready without any stored Ready gate decision, so the check fails: the PR
      // stays open, a notice names the rule and the task, and it is not mergeable.
      const { report } = await s.lane().submit({
        kind: "edit",
        key: two,
        subject: "TASK-2",
        target: { status: "Ready" },
      });
      const branch = report.branch as string;
      const tip = (await repo.git("rev-parse", branch)).trim();
      expect(findPr(s.office, 1)).toMatchObject({
        state: "open",
        check: "failed",
        checkedHead: tip,
      });
      expect(s.host.prs.get(1)?.state).toBe("open");
      expect(backlogPrMergeable(s.office, 1, tip)).toBe(false);
      const failed = notices(s.office).filter((n) => n.code === PR_NOTICES.checkFailed);
      expect(failed.map((n) => n.key)).toEqual([two]);
      expect(failed[0]?.text).toContain("[ready-decision] on TASK-2");
      expect(backlogCheckBlocked(s.office, two)).toBeNull();

      // The maintainer merges it by hand with a merge commit, so the head is now on main. After the
      // poll's fetch the merge is seen and checked again against the base the open check used, not
      // against main (which would be an empty diff that passes), and it blocks TASK-2.
      const mergeCommit = await mergeCommitOnRemote(repo, branch);
      s.host.mergedByHand(1, tip, mergeCommit);
      await s.git.fetch();
      await s.prs.sync(s.officeId);
      expect(findPr(s.office, 1)).toMatchObject({ state: "merged", check: "failed" });
      const merged = notices(s.office).filter((n) => n.code === PR_NOTICES.mergedCheckFailed);
      expect(merged.map((n) => [n.key, n.level])).toEqual([[two, "error"]]);
      expect(merged[0]?.text).toContain("merged by hand");
      expect(backlogCheckBlocked(s.office, two)).toMatchObject({ reason: "notRunnable", prs: [1] });
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
