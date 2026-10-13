// CI only (0017 section 1): Done detection and teardown against a real temporary repository, a
// bare remote and the pinned Backlog CLI (DIPO-58; 0010 section 7). The story branch is
// squash-merged on the bare remote, as the host's squash merge does; the poll detects Done with
// `git merge-tree` and tears down the worktree, the local and the remote branch. A dirty worktree
// is kept with a notice listing its files until it is clean. Fast versions of the same rules with a
// fake git are in teardown.test.ts.

import { describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { git, type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { OFFICE_DEFAULTS } from "../../src/config";
import {
  type ClaimOutcome,
  claimStory,
  DONE_RELEASE_REASON,
  findClaim,
  SlotTable,
  StoryTeardown,
  TEARDOWN_NOTICES,
} from "../../src/worktree";
import { squashMergeOnRemote } from "../backlog/lane/helpers";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  claimSetup,
  type ClaimSetup,
  inRemote,
  notices,
  publish,
} from "./helpers";

function claimed(outcome: ClaimOutcome): Extract<ClaimOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`expected a claim, got the skip ${outcome.reason}`);
  return outcome;
}

async function refExists(cwd: string, home: string, ref: string): Promise<boolean> {
  return git(cwd, home, "rev-parse", "--verify", "--quiet", ref).then(
    () => true,
    () => false,
  );
}

/** Claims TASK-1, commits work on its branch, pushes it and squash-merges it on the remote. */
async function claimWorkMerge(repo: TempRepoWithRemote, s: ClaimSetup) {
  const claim = claimed(await claimStory(s.deps(), s.request(s.key()))).claim;
  writeFileSync(join(claim.worktree, "work.txt"), "work\n");
  await git(claim.worktree, repo.home, "add", "work.txt");
  await git(claim.worktree, repo.home, "commit", "--quiet", "-m", "work");
  await git(claim.worktree, repo.home, "push", "--quiet", "origin", BRANCH_1);
  await squashMergeOnRemote(repo, BRANCH_1);
  const fetched = await s.git.fetch();
  if (!fetched.ok) throw fetched.error;
  return claim;
}

function teardownOf(s: ClaimSetup, slots: SlotTable): StoryTeardown {
  const teardown = new StoryTeardown({
    git: () => s.git,
    host: null,
    cli: s.cli,
    offices: { get: () => s.office, config: () => OFFICE_DEFAULTS },
    slots,
  });
  teardown.track(s.office.officeId as OfficeId, s.office, s.t.clock);
  return teardown;
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("Done and teardown on a real repository", () => {
    it("detects a squash merge with merge-tree and removes the worktree and both branches", async () => {
      await withBareRemote(
        async (repo) => {
          await publish(repo);
          const s = await claimSetup(repo);
          const claim = await claimWorkMerge(repo, s);
          const slots = SlotTable.inState(join(repo.root, "slots"));
          slots.take({ office: "o", story: "TASK-1", worktree: claim.worktree, takenAt: 1 }, 20);
          // The branch is not an ancestor of the base after a squash merge.
          const ancestor = await repo.run([
            "git",
            "merge-base",
            "--is-ancestor",
            BRANCH_1,
            "origin/main",
          ]);
          expect(ancestor.exitCode).toBe(1);

          const report = await teardownOf(s, slots).poll(s.office.officeId as OfficeId);

          expect(report.tornDown.map((c) => c.runId)).toEqual([claim.runId]);
          expect(existsSync(claim.worktree)).toBe(false);
          expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
          expect(await inRemote(repo, "branch", "--list", BRANCH_1).then((out) => out.trim())).toBe(
            "",
          );
          expect(findClaim(s.office, claim.runId)?.releaseReason).toBe(DONE_RELEASE_REASON);
          expect(slots.slotOf(claim.worktree)).toBeNull();
          expect(notices(s.office).map((n) => n.code)).toContain(TEARDOWN_NOTICES.done);
        },
        { fixture: BACKLOG_FIXTURE },
      );
    });

    it("keeps a dirty worktree with a notice, then tears it down once it is clean", async () => {
      await withBareRemote(
        async (repo) => {
          await publish(repo);
          const s = await claimSetup(repo);
          const claim = await claimWorkMerge(repo, s);
          writeFileSync(join(claim.worktree, "scratch.txt"), "left behind\n");
          const slots = SlotTable.inState(join(repo.root, "slots"));
          const teardown = teardownOf(s, slots);
          const officeId = s.office.officeId as OfficeId;

          const kept = await teardown.poll(officeId);
          expect(kept.kept.map((c) => c.runId)).toEqual([claim.runId]);
          expect(existsSync(join(claim.worktree, "scratch.txt"))).toBe(true);
          expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(true);
          expect((await inRemote(repo, "branch", "--list", BRANCH_1)).trim()).not.toBe("");
          expect(findClaim(s.office, claim.runId)?.releasedAt).toBeNull();
          const list = await repo.git("worktree", "list", "--porcelain");
          expect(list).toContain(`locked dipo ${claim.runId}`);
          const told = notices(s.office).filter((n) => n.code === TEARDOWN_NOTICES.kept);
          expect(told).toHaveLength(1);
          expect(told[0]?.text).toContain("scratch.txt");

          rmSync(join(claim.worktree, "scratch.txt"));
          const done = await teardown.poll(officeId);
          expect(done.tornDown.map((c) => c.runId)).toEqual([claim.runId]);
          expect(existsSync(claim.worktree)).toBe(false);
          expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
        },
        { fixture: BACKLOG_FIXTURE },
      );
    });
  });
}
