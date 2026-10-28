// CI only (0017 section 1): the slower claim cases against real temporary repositories, a bare
// remote and the pinned Backlog CLI (DIPO-38, DIPO-349; 0010 sections 2 and 2a), kept out of the
// local suite for its time budget (DIPO-77, DIPO-79): the full claim from origin/main with the
// push, the skips of a story's own live claim and of a ref tracked for another story with a
// remote, a lane-b operation submitted during the pickup re-check, and the reuse of a branch after
// a real release and push. Fast local versions are in claim.test.ts and claim-reuse.test.ts.

import { describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { StoryKey } from "@dipsaus-orchestrator/contract";
import { git, type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { LaneError } from "../../src/backlog/lane";
import {
  claimStory,
  type ClaimOutcome,
  hasLiveClaim,
  liveClaims,
  releaseClaim,
  releasedBranchFor,
} from "../../src/worktree";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  byHandOn,
  claimSetup,
  type ClaimSetup,
  filesOf,
  inRemote,
  laneOf,
  notices,
  otherClone,
  publish,
  pushStatusChange,
  subjects,
  TASK_1,
  TASK_FILE_1,
} from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

function claimed(outcome: ClaimOutcome): Extract<ClaimOutcome, { ok: true }> {
  if (!outcome.ok)
    throw new Error(`expected a claim, got the skip ${outcome.reason}: ${outcome.notice}`);
  return outcome;
}

/**
 * Claims TASK-1, commits `file` with `content` on its branch by hand, pushes it and releases the
 * claim keeping the branch as 0010 section 2a does. Returns the kept tip.
 */
async function claimWorkRelease(
  repo: TempRepoWithRemote,
  s: ClaimSetup,
  key: StoryKey,
  file: string,
  content: string,
): Promise<string> {
  const first = claimed(await claimStory(s.deps(), s.request(key))).claim;
  await byHandOn(repo, BRANCH_1, async (dir) => {
    writeFileSync(join(dir, file), content);
    await git(dir, repo.home, "add", file);
    await git(dir, repo.home, "commit", "--quiet", "-m", "work");
    await git(dir, repo.home, "push", "--quiet", "origin", BRANCH_1);
  });
  s.office.immediate(() =>
    releaseClaim(s.office, first.runId, {
      at: s.t.clock.now(),
      reason: "amend",
      keepBranch: true,
    }),
  );
  expect(releasedBranchFor(s.office, key, BRANCH_1)).not.toBeNull();
  return (await repo.git("rev-parse", BRANCH_1)).trim();
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("claiming a story", () => {
    it("creates the branch from origin/main, commits only the task file and pushes, with no worktree", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const main = (await repo.git("rev-parse", "HEAD")).trim();
        const s = await claimSetup(repo);
        const key = s.key();

        const outcome = claimed(await claimStory(s.deps(), s.request(key)));
        const claim = outcome.claim;

        expect(outcome.pushed).toBe(true);
        expect(claim.startSha).toBe(main);
        expect(claim.baseSha).toBe(main);
        expect(claim.reused).toBe(false);
        expect(hasLiveClaim(s.office, key)).toBe(true);

        // One claim commit on the branch, changing only the story's task file.
        expect(await subjects(repo.dir, repo.home, BRANCH_1, "main")).toEqual([
          `${TASK_1}: status In Progress`,
        ]);
        const tip = (await repo.git("rev-parse", BRANCH_1)).trim();
        expect(claim.claimSha).toBe(tip);
        expect(await filesOf(repo.dir, repo.home, tip)).toEqual([TASK_FILE_1]);
        expect(await repo.git("show", `${tip}:${TASK_FILE_1}`)).toContain("status: In Progress");

        // The remote has the branch at the claim commit, pushed without force.
        expect((await inRemote(repo, "rev-parse", `refs/heads/${BRANCH_1}`)).trim()).toBe(tip);
        expect(claim.pushedAt).not.toBeNull();

        // No worktree, and the main checkout stays on main with no change.
        expect(existsSync(join(s.git.worktreeRoot(), TASK_1))).toBe(false);
        expect(await repo.git("worktree", "list", "--porcelain")).not.toContain(BRANCH_1);
        expect((await repo.git("rev-parse", "HEAD")).trim()).toBe(main);
        expect(await repo.git("status", "--porcelain")).toBe("");
        expect(notices(s.office)).toEqual([]);
      }, FIXTURE);
    });
  });

  describe("claim collisions", () => {
    it("skips its own live claim silently, and a ref tracked for another story with a notice naming it", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const first = s.key();
        claimed(await claimStory(s.deps(), s.request(first)));
        const tip = (await repo.git("rev-parse", BRANCH_1)).trim();

        const again = await claimStory(s.deps(), s.request(first));
        expect(again).toEqual({ ok: false, reason: "notRunnable", notice: null, code: null });
        expect(notices(s.office)).toEqual([]);

        const outcome = await claimStory(s.deps(), s.request(s.key()));
        expect(outcome).toMatchObject({ ok: false, reason: "collision" });
        expect(outcome.ok ? "" : outcome.notice).toContain(`tracked for another story (${first})`);
        expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(tip);
        expect(liveClaims(s.office)).toHaveLength(1);
      }, FIXTURE);
    });
  });

  describe("the claim and the planning lane in the office git queue", () => {
    it("runs a lane-b operation submitted during the pickup re-check after the claim, which refuses it", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const key = s.key();
        // The pickup re-check runs inside the claim's queue item, so a journal item submitted from
        // it cannot interleave: it waits for the claim to finish and then meets the live claim.
        let journal: Promise<unknown> | undefined;
        const outcome = await claimStory(s.deps(), {
          ...s.request(key),
          recheck: () => {
            journal ??= laneOf(s)
              .journal({ kind: "edit", key, subject: TASK_1, target: { status: "Refined" } })
              .then(
                () => "journaled",
                (error: unknown) => error,
              );
            return null;
          },
        });
        const journaled = await journal;
        expect(outcome.ok).toBe(true);
        expect(journaled).toBeInstanceOf(LaneError);
        expect((journaled as LaneError).code).toBe("backlog.lane.liveClaim");
      }, FIXTURE);
    });
  });

  describe("reusing a released branch", () => {
    it("reuses it at its kept tip after the base moved, and pushes the claim commit", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const key = s.key();
        const kept = await claimWorkRelease(repo, s, key, "work.txt", "work\n");
        // The base moves on: lane b changed another story, and a code change landed.
        await pushStatusChange(repo, { "TASK-2": "Ready" });
        const other = await otherClone(repo);
        writeFileSync(join(other, "other.txt"), "other\n");
        await git(other, repo.home, "add", "other.txt");
        await git(other, repo.home, "commit", "--quiet", "-m", "other");
        await git(other, repo.home, "push", "--quiet", "origin", "HEAD:main");
        const base = (await git(other, repo.home, "rev-parse", "HEAD")).trim();

        const outcome = claimed(await claimStory(s.deps(), s.request(key)));
        const claim = outcome.claim;

        expect(claim.reused).toBe(true);
        expect(claim.startSha).toBe(kept);
        expect(claim.baseSha).toBe(base);
        expect(outcome.pushed).toBe(true);
        expect(releasedBranchFor(s.office, key, BRANCH_1)).toBeNull();
        // The kept branch already says In Progress, so the claim adds no commit; dipo's catch-up
        // merges the base later (DIPO-149).
        expect(await subjects(repo.dir, repo.home, BRANCH_1, kept)).toEqual([]);
        expect(claim.claimSha).toBe(kept);
        expect(await repo.git("show", `${kept}:${TASK_FILE_1}`)).toContain("status: In Progress");
        expect((await inRemote(repo, "rev-parse", `refs/heads/${BRANCH_1}`)).trim()).toBe(
          claim.claimSha as string,
        );
      }, FIXTURE);
    });
  });
}
