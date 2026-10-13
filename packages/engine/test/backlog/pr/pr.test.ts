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
import { BACKLOG_FIXTURE, notices, publish, squashMergeOnRemote } from "../lane/helpers";

import { laneSetup, prSetup, REPO } from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

describe("the backlog PR", () => {
  it("opens one PR once gh is logged in, updates it, checks each head and checks a hand merge again", async () => {
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

      // A second operation appends to the branch and updates the same PR, which is checked again.
      // TASK-2 becomes Ready without any stored Ready gate decision, so the check fails: the PR
      // stays open, a notice names the rule and the task, and it is not mergeable.
      await s.lane().submit({
        kind: "edit",
        key: keys.two,
        subject: "TASK-2",
        target: { status: "Ready" },
      });
      expect(s.host.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
      expect(s.host.prs.get(1)?.title).toBe(`${TITLE_PREFIX}edit TASK-1, edit TASK-2`);
      expect(s.host.prs.get(1)?.state).toBe("open");
      const newTip = (await repo.git("rev-parse", branch)).trim();
      expect(findPr(s.office, 1)).toMatchObject({
        state: "open",
        check: "failed",
        checkedHead: newTip,
      });
      expect(backlogPrMergeable(s.office, 1, newTip)).toBe(false);
      const failed = notices(s.office).filter((n) => n.code === PR_NOTICES.checkFailed);
      expect(failed.map((n) => n.key)).toEqual([keys.two]);
      expect(failed[0]?.text).toContain("[ready-decision] on TASK-2");
      expect(backlogCheckBlocked(s.office, keys.two)).toBeNull();
      // The PR is stored on every journal entry of the branch.
      expect(allEntries(s.office).map((entry) => entry.prRef)).toEqual([
        `https://github.com/${REPO}/pull/1`,
        `https://github.com/${REPO}/pull/1`,
      ]);

      // The maintainer merges it by hand: the merge is seen, checked again, and blocks TASK-2.
      await squashMergeOnRemote(repo, branch);
      s.host.mergedByHand(1, newTip);
      await s.prs.sync(s.officeId);
      expect(findPr(s.office, 1)).toMatchObject({ state: "merged", check: "failed" });
      const merged = notices(s.office).filter((n) => n.code === PR_NOTICES.mergedCheckFailed);
      expect(merged.map((n) => [n.key, n.level])).toEqual([[keys.two, "error"]]);
      expect(merged[0]?.text).toContain("merged by hand");
      expect(backlogCheckBlocked(s.office, keys.two)).toMatchObject({
        reason: "notRunnable",
        prs: [1],
      });
      expect(backlogCheckBlocked(s.office, keys.one)).toBeNull();
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
