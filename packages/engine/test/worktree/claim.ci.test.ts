// CI only (0017 section 1): the slower claim cases against real temporary repositories, a bare
// remote and the pinned Backlog CLI (DIPO-38; 0010 sections 2 and 2a), kept out of the local suite
// for its time budget (DIPO-77): the reuse of a released branch with the base merged in or a code
// conflict after a real release and push, and claims that fail after the worktree exists with a
// tip the claim cannot name, or a reused branch to move back and claim again. Fast local versions
// of the same rules are in claim-reuse.test.ts. Moved for the same budget (DIPO-79): the full claim
// from origin/main with the push (fast local version: the claim without a remote in claim.test.ts),
// and a lane-b operation submitted during the pickup re-check, which waits for the claim and meets
// the live claim (fast local versions: the journaled-first skip in claim.test.ts and the live-claim
// refusal in backlog/lane/lane.test.ts); and the skip of a story's own live claim and of a ref
// tracked for another story with a remote (fast local version: the claim without a remote).

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { StoryKey } from "@dipsaus-orchestrator/contract";
import {
  git,
  type TempRepoWithRemote,
  withBareRemote,
  withTempRepo,
} from "@dipsaus-orchestrator/testkit";

import { type GitCall, type GitResult, type GitSettings, spawnGitExec } from "../../src/git";
import { LaneError } from "../../src/backlog/lane";
import { systemSpawn } from "../../src/platform/process";
import {
  CLAIM_NOTICES,
  claimStory,
  type ClaimOutcome,
  findClaim,
  hasLiveClaim,
  liveClaims,
  releaseClaim,
  releasedBranchFor,
} from "../../src/worktree";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  claimSetup,
  type ClaimSetup,
  filesOf,
  inRemote,
  laneOf,
  notices,
  otherClone,
  publish,
  pushStatusChange,
  secondGit,
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

async function refExists(cwd: string, home: string, ref: string): Promise<boolean> {
  return git(cwd, home, "rev-parse", "--verify", "--quiet", ref).then(
    () => true,
    () => false,
  );
}

/** Git settings with base `main` and the worktree root `root`. */
function rootedAt(root: string): GitSettings {
  return { remote: "origin", base: "main", worktreeRoot: root };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

/**
 * Claims TASK-1, commits `file` with `content` on its branch, then releases the claim keeping the
 * branch as 0010 section 2a does: the task file restored to its merge-base version and committed,
 * the branch pushed, the worktree removed, the release recorded. Returns the kept tip.
 */
async function claimWorkRelease(
  repo: TempRepoWithRemote,
  s: ClaimSetup,
  key: StoryKey,
  file: string,
  content: string,
): Promise<string> {
  const first = claimed(await claimStory(s.deps(), s.request(key))).claim;
  const wt = first.worktree;
  writeFileSync(join(wt, file), content);
  await git(wt, repo.home, "add", file);
  await git(wt, repo.home, "commit", "--quiet", "-m", "work");
  const mergeBase = (await git(wt, repo.home, "merge-base", "HEAD", "origin/main")).trim();
  await git(wt, repo.home, "checkout", mergeBase, "--", TASK_FILE_1);
  await git(wt, repo.home, "commit", "--quiet", "-m", `${TASK_1}: release claim`);
  await git(wt, repo.home, "push", "--quiet", "origin", BRANCH_1);
  await repo.git("worktree", "unlock", wt);
  await repo.git("worktree", "remove", wt);
  s.git.unpinWorktree(wt);
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

/** An executor that fails the calls `fail` picks (with `seen`, the earlier calls' arguments). */
function failing(
  fail: (args: readonly string[], seen: readonly (readonly string[])[]) => boolean,
): (call: GitCall) => Promise<GitResult> {
  const real = spawnGitExec(systemSpawn);
  const seen: (readonly string[])[] = [];
  return async (call) => {
    const injected = fail(call.args, seen);
    seen.push(call.args);
    if (injected) return { code: 128, stdout: "", stderr: "fatal: injected failure" };
    return real(call);
  };
}

/**
 * The `rev-parse --verify HEAD` that reads the claim commit back, after `git commit-tree` made it
 * and `git update-ref` moved the branch (DIPO-270).
 */
function afterClaimCommit(args: readonly string[], seen: readonly (readonly string[])[]): boolean {
  return (
    args.includes("rev-parse") &&
    args.at(-1) === "HEAD" &&
    seen.some((earlier) => earlier.includes("commit-tree")) &&
    seen.some((earlier) => earlier.includes("update-ref"))
  );
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("claiming a story", () => {
    it("creates the branch and a locked worktree from origin/main, commits only the task file and pushes", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const main = (await repo.git("rev-parse", "HEAD")).trim();
        const s = await claimSetup(repo);
        const key = s.key();
        const request = s.request(key);

        const outcome = claimed(await claimStory(s.deps(), request));
        const claim = outcome.claim;

        expect(outcome.pushed).toBe(true);
        expect(claim.worktree).toBe(join(s.git.worktreeRoot(), TASK_1));
        expect(claim.startSha).toBe(main);
        expect(claim.baseSha).toBe(main);
        expect(claim.reused).toBe(false);
        expect(claim.firstFeedback).toBeNull();
        expect(hasLiveClaim(s.office, key)).toBe(true);

        // One claim commit on the branch, changing only the story's task file.
        expect(await subjects(repo.dir, repo.home, BRANCH_1, "main")).toEqual([
          `${TASK_1}: status In Progress`,
        ]);
        const tip = (await repo.git("rev-parse", BRANCH_1)).trim();
        expect(claim.claimSha).toBe(tip);
        expect(await filesOf(repo.dir, repo.home, tip)).toEqual([TASK_FILE_1]);
        expect(readFileSync(join(claim.worktree, TASK_FILE_1), "utf8")).toContain(
          "status: In Progress",
        );

        // The remote has the branch at the claim commit, pushed without force.
        expect((await inRemote(repo, "rev-parse", `refs/heads/${BRANCH_1}`)).trim()).toBe(tip);
        expect(claim.pushedAt).not.toBeNull();

        // The worktree is locked with the run id.
        const list = await repo.git("worktree", "list", "--porcelain");
        const entry = list
          .split("\n\n")
          .find((block) => block.includes(`worktree ${claim.worktree}`));
        expect(entry).toContain(`locked dipo ${request.runId}`);
        expect(entry).toContain(`branch refs/heads/${BRANCH_1}`);

        // The main checkout stays on main with no change.
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
    it("reuses it with the base merged in before the claim commit", async () => {
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
        expect(claim.firstFeedback).toBeNull();
        expect(outcome.pushed).toBe(true);
        expect(releasedBranchFor(s.office, key, BRANCH_1)).toBeNull();
        const log = await subjects(repo.dir, repo.home, BRANCH_1, kept);
        expect(log.at(-1)).toBe(`${TASK_1}: status In Progress`);
        expect(log).toContain(`Merge origin/main into ${BRANCH_1}`);
        expect(existsSync(join(claim.worktree, "work.txt"))).toBe(true);
        expect(existsSync(join(claim.worktree, "other.txt"))).toBe(true);
        expect(await filesOf(repo.dir, repo.home, claim.claimSha as string)).toEqual([TASK_FILE_1]);
        expect((await inRemote(repo, "rev-parse", `refs/heads/${BRANCH_1}`)).trim()).toBe(
          claim.claimSha as string,
        );
      }, FIXTURE);
    });

    it("aborts a code conflict, completes the claim and records the conflict as first feedback", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const key = s.key();
        await claimWorkRelease(repo, s, key, "shared.txt", "branch\n");
        const other = await otherClone(repo);
        writeFileSync(join(other, "shared.txt"), "base\n");
        await git(other, repo.home, "add", "shared.txt");
        await git(other, repo.home, "commit", "--quiet", "-m", "shared on base");
        await git(other, repo.home, "push", "--quiet", "origin", "HEAD:main");

        const claim = claimed(await claimStory(s.deps(), s.request(key))).claim;

        expect(claim.firstFeedback).toContain("shared.txt");
        expect(claim.firstFeedback).toContain("conflicts");
        expect(await refExists(claim.worktree, repo.home, "MERGE_HEAD")).toBe(false);
        expect(readFileSync(join(claim.worktree, "shared.txt"), "utf8")).toBe("branch\n");
        expect(await subjects(repo.dir, repo.home, BRANCH_1, "origin/main")).toContain(
          `${TASK_1}: status In Progress`,
        );
        expect(notices(s.office).map((n) => n.code)).toEqual([CLAIM_NOTICES.mergeConflict]);
        expect(findClaim(s.office, claim.runId)?.firstFeedback).toBe(claim.firstFeedback);
      }, FIXTURE);
    });
  });

  describe("a claim that fails after the worktree exists", () => {
    it("names a branch it could not roll back as left over from the story's failed claim", async () => {
      await withTempRepo(async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const key = s.key();
        // The claim commit's id is never read, so the tip is not a commit the claim knows it made.
        const broken = secondGit(repo, s, rootedAt("../repo.worktrees"), failing(afterClaimCommit));
        await caught(claimStory(s.deps({ git: broken }), s.request(key)));
        expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(true);
        expect(notices(s.office).map((n) => n.code)).toEqual([CLAIM_NOTICES.leftover]);

        const outcome = await claimStory(s.deps(), s.request(key));

        expect(outcome).toMatchObject({ ok: false, reason: "collision" });
        expect(outcome.ok ? "" : outcome.notice).toContain(
          "left over from an earlier failed claim of this story",
        );
        expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(true);
      }, FIXTURE);
    });

    it("moves a reused branch back to its kept tip after the base merge and reopens the release", async () => {
      await withBareRemote(async (repo) => {
        await publish(repo);
        const s = await claimSetup(repo);
        const key = s.key();
        const kept = await claimWorkRelease(repo, s, key, "work.txt", "work\n");
        const other = await otherClone(repo);
        writeFileSync(join(other, "other.txt"), "other\n");
        await git(other, repo.home, "add", "other.txt");
        await git(other, repo.home, "commit", "--quiet", "-m", "other");
        await git(other, repo.home, "push", "--quiet", "origin", "HEAD:main");
        // Fails the status check of the claim commit, after the merge of origin/main.
        const broken = secondGit(
          repo,
          s,
          rootedAt("../repo.worktrees"),
          failing((args, seen) => args.includes("status") && seen.some((a) => a.includes("merge"))),
        );

        await caught(claimStory(s.deps({ git: broken }), s.request(key)));

        expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(kept);
        expect(releasedBranchFor(s.office, key, BRANCH_1)).not.toBeNull();
        const again = claimed(await claimStory(s.deps(), s.request(key))).claim;
        expect(again.reused).toBe(true);
        expect(again.startSha).toBe(kept);
      }, FIXTURE);
    });
  });
}
