// The slower backlog PR cases, in CI only (0017): a failing PR kept open with a notice and not
// mergeable, whose merge commit by hand is checked again and blocks its story (moved from pr.test.ts
// for the local time budget, DIPO-79); a block is cleared once a later backlog PR that
// touches the story merges with a passing check (after a squash merge), a new Ready that matches
// a stored passing gate decision passes, a rebase merge is checked against the recorded base, and
// a merged PR without a recorded base falls back to the merge commit, or stays open to be
// retried when its check cannot run. The fast tests of the same rules are in check.test.ts and records.test.ts.

import { describe, expect, it } from "bun:test";

import { StoryId, type StoryKey } from "@dipsaus-orchestrator/contract";
import { withBareRemote } from "@dipsaus-orchestrator/testkit";

import { viewStory } from "../../../src/backlog/fields/write";
import {
  backlogCheckBlocked,
  backlogPrMergeable,
  findPr,
  PR_NOTICES,
} from "../../../src/backlog/pr";
import { gateStoryFromView } from "../../../src/gate/input";
import { gateContentHash } from "../../../src/gate";
import { storeGateDecision } from "../../../src/gate-decisions";
import { addStory } from "../../../src/stories/keys";
import { BACKLOG_FIXTURE, notices, publish, squashMergeOnRemote } from "../lane/helpers";

import { laneSetup, mergeCommitOnRemote, prSetup, rebaseMergeOnRemote } from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the backlog PR", () => {
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
        expect(backlogCheckBlocked(s.office, two)).toMatchObject({
          reason: "notRunnable",
          prs: [1],
        });
      }, FIXTURE);
    });

    it("clears a block once a later backlog PR touching the story merges with a passing check", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await prSetup(repo, await laneSetup(repo));
        const one = addStory(s.office, s.t.ids, { story: StoryId.parse("TASK-1") }, 0).key;
        // An earlier merged PR #9 failed on TASK-1.
        s.office.immediate(() =>
          s.office.run(
            `insert into backlog_pr_blocks (office_id, key, pr_number, failures, blocked_at)
           values ($office_id, $key, 9, '[]', 0)`,
            { key: one },
          ),
        );
        expect(backlogCheckBlocked(s.office, one)?.prs).toEqual([9]);

        const { report } = await s.lane().submit({
          kind: "edit",
          key: one,
          subject: "TASK-1",
          target: { status: "Refined" },
        });
        const branch = report.branch as string;
        expect(findPr(s.office, 1)?.check).toBe("passed");
        await squashMergeOnRemote(repo, branch);
        s.host.mergedByHand(1, (await repo.git("rev-parse", branch)).trim());
        await s.prs.sync(s.officeId);
        expect(backlogCheckBlocked(s.office, one)).toBeNull();
      }, FIXTURE);
    });

    it("passes a new Ready that matches a stored passing gate decision", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await prSetup(repo, await laneSetup(repo));
        const two = addStory(s.office, s.t.ids, { story: StoryId.parse("TASK-2") }, 0).key;
        // The decision is stored for the hash the head's view of TASK-2 gives; status is not hashed.
        const view = await viewStory({ cli: s.cli, cwd: repo.dir, id: "TASK-2", kind: "task" });
        s.office.immediate(() =>
          storeGateDecision(s.office, s.t.ids, {
            key: two,
            result: { mode: "ready", passed: true, failures: [] },
            contentHash: gateContentHash(gateStoryFromView(view, [])),
            at: 0,
          }),
        );
        await s
          .lane()
          .submit({ kind: "edit", key: two, subject: "TASK-2", target: { status: "Ready" } });
        expect(findPr(s.office, 1)).toMatchObject({ check: "passed", failures: [] });
      }, FIXTURE);
    });

    it("checks a rebase merge by hand against the base the open check used", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await prSetup(repo, await laneSetup(repo));
        const two = addStory(s.office, s.t.ids, { story: StoryId.parse("TASK-2") }, 0).key;
        const { report } = await s.lane().submit(readyWithoutDecision(two));
        const branch = report.branch as string;
        const tip = (await repo.git("rev-parse", branch)).trim();
        const rebased = await rebaseMergeOnRemote(repo, branch);
        s.host.mergedByHand(1, tip, rebased);
        await s.git.fetch();
        await s.prs.sync(s.officeId);
        expect(findPr(s.office, 1)).toMatchObject({ state: "merged", check: "failed" });
        expect(backlogCheckBlocked(s.office, two)?.prs).toEqual([1]);
      }, FIXTURE);
    });

    it("falls back to the merge commit's first parent, and retries a merged PR whose check failed to run", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await prSetup(repo, await laneSetup(repo));
        const two = addStory(s.office, s.t.ids, { story: StoryId.parse("TASK-2") }, 0).key;
        const { report } = await s.lane().submit(readyWithoutDecision(two));
        const branch = report.branch as string;
        const tip = (await repo.git("rev-parse", branch)).trim();
        // As if no check had recorded its base for this head.
        s.office.immediate(() =>
          s.office.run("update backlog_prs set checked_base = null where office_id = $office_id"),
        );
        const mergeCommit = await mergeCommitOnRemote(repo, branch);
        await s.git.fetch();

        // The host does not name the merge commit: the head is on main and no base is recorded, so
        // the check cannot tell the PR's changes apart. It reports that and leaves the PR open.
        s.host.mergedByHand(1, tip, null);
        await expect(s.prs.sync(s.officeId)).rejects.toThrow("cannot be told apart");
        expect(findPr(s.office, 1)?.state).toBe("open");
        expect(notices(s.office).some((n) => n.code === PR_NOTICES.checkError)).toBe(true);
        expect(backlogCheckBlocked(s.office, two)).toBeNull();

        // The next sync, with the merge commit known, checks against its first parent.
        s.host.mergedByHand(1, tip, mergeCommit);
        await s.prs.sync(s.officeId);
        expect(findPr(s.office, 1)).toMatchObject({ state: "merged", check: "failed" });
        expect(backlogCheckBlocked(s.office, two)?.prs).toEqual([1]);
      }, FIXTURE);
    });
  });
}

function readyWithoutDecision(key: StoryKey) {
  return { kind: "edit", key, subject: "TASK-2", target: { status: "Ready" } };
}
