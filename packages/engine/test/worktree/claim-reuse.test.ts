// Fast local cases of the claim rules whose full versions run in CI only (claim.ci.test.ts,
// DIPO-77): the reuse of a released branch with the base merged in, a code conflict aborted and
// recorded as first feedback, a reused branch moved back to its kept tip when the claim fails, and
// a foreign commit on the claim commit left over with a notice (DIPO-38; 0010 sections 2 and 2a).
// No remote: the base is the local `main`, so nothing is cloned, pushed or fetched, and the
// released branch is made by hand instead of by a first claim.

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { StoryKey } from "@dipsaus-orchestrator/contract";
import { git, type TempRepo, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { OfficeHandle } from "../../src/db/office";
import { type GitCall, type GitResult, spawnGitExec } from "../../src/git";
import type { RunResult, SqlParams } from "../../src/platform/sqlite";
import { systemSpawn } from "../../src/platform/process";
import {
  CLAIM_NOTICES,
  claimStory,
  type ClaimOutcome,
  findClaim,
  releasedBranchFor,
} from "../../src/worktree";
import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  claimSetup,
  type ClaimSetup,
  filesOf,
  notices,
  publish,
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

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

/**
 * A branch released for `key` as 0010 section 2a leaves it, made without a first claim: `BRANCH_1`
 * holds one work commit on the base (the task file as on the base) and the release is recorded.
 * Returns the kept tip.
 */
async function releasedBranch(
  repo: TempRepo,
  s: ClaimSetup,
  key: StoryKey,
  file: string,
  content: string,
): Promise<string> {
  await repo.git("checkout", "--quiet", "-b", BRANCH_1);
  writeFileSync(join(repo.dir, file), content);
  await repo.git("add", file);
  await repo.git("commit", "--quiet", "-m", "work");
  await repo.git("checkout", "--quiet", "main");
  s.office.immediate(() =>
    s.office.run(
      `insert into released_branches (office_id, branch, released_at, key, reason)
       values ($office_id, $branch, $at, $key, 'amend')`,
      { branch: BRANCH_1, at: s.t.clock.now(), key },
    ),
  );
  expect(releasedBranchFor(s.office, key, BRANCH_1)).not.toBeNull();
  return (await repo.git("rev-parse", BRANCH_1)).trim();
}

/** Commits `file` with `content` on the local base `main`, as a change landing there would. */
async function commitOnBase(repo: TempRepo, file: string, content: string): Promise<string> {
  writeFileSync(join(repo.dir, file), content);
  await repo.git("add", file);
  await repo.git("commit", "--quiet", "-m", `${file} on base`);
  return (await repo.git("rev-parse", "HEAD")).trim();
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

/** An office handle whose write of the claim commit fails, after running `before`. */
class FailingOffice extends OfficeHandle {
  constructor(
    s: ClaimSetup,
    readonly before: () => void,
  ) {
    super(s.t.state.connection, s.office.officeId);
  }

  override run(sql: string, params: SqlParams = {}): RunResult {
    if (sql.includes("claim_sha = coalesce") && params["claim_sha"] !== null) {
      this.before();
      throw new Error("injected database failure");
    }
    return super.run(sql, params);
  }
}

describe("reusing a released branch against the local base", () => {
  it("aborts a code conflict, completes the claim and records the conflict as first feedback", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      await releasedBranch(repo, s, key, "shared.txt", "branch\n");
      await commitOnBase(repo, "shared.txt", "base\n");

      const claim = claimed(await claimStory(s.deps(), s.request(key))).claim;

      expect(claim.reused).toBe(true);
      expect(claim.firstFeedback).toContain("shared.txt");
      expect(claim.firstFeedback).toContain("conflicts");
      const mergeHead = git(
        claim.worktree,
        repo.home,
        "rev-parse",
        "--verify",
        "--quiet",
        "MERGE_HEAD",
      );
      expect(
        await mergeHead.then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(readFileSync(join(claim.worktree, "shared.txt"), "utf8")).toBe("branch\n");
      expect(notices(s.office).map((n) => n.code)).toEqual([CLAIM_NOTICES.mergeConflict]);
      expect(findClaim(s.office, claim.runId)?.firstFeedback).toBe(claim.firstFeedback);
    }, FIXTURE);
  });

  it("moves a reused branch back to its kept tip after the base merge and reopens the release, then reuses it with the base merged in", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      const kept = await releasedBranch(repo, s, key, "work.txt", "work\n");
      const base = await commitOnBase(repo, "other.txt", "other\n");
      // Fails the status check of the claim commit, after the merge of the base.
      const broken = secondGit(
        repo,
        s,
        { remote: "origin", base: "main", worktreeRoot: "../repo.worktrees" },
        failing((args, seen) => args.includes("status") && seen.some((a) => a.includes("merge"))),
      );

      await caught(claimStory(s.deps({ git: broken }), s.request(key)));

      expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(kept);
      expect(releasedBranchFor(s.office, key, BRANCH_1)).not.toBeNull();

      // The next claim reuses the kept tip and merges the base in before the claim commit.
      const outcome = claimed(await claimStory(s.deps(), s.request(key)));
      const claim = outcome.claim;
      expect(claim.reused).toBe(true);
      expect(claim.startSha).toBe(kept);
      expect(claim.baseSha).toBe(base);
      expect(claim.firstFeedback).toBeNull();
      expect(outcome.pushed).toBe(false);
      expect(releasedBranchFor(s.office, key, BRANCH_1)).toBeNull();
      expect((await subjects(repo.dir, repo.home, BRANCH_1, kept)).at(-1)).toBe(
        `${TASK_1}: status In Progress`,
      );
      expect(existsSync(join(claim.worktree, "work.txt"))).toBe(true);
      expect(existsSync(join(claim.worktree, "other.txt"))).toBe(true);
      expect(await filesOf(repo.dir, repo.home, claim.claimSha as string)).toEqual([TASK_FILE_1]);
    }, FIXTURE);
  });
});

describe("a claim that fails after the worktree exists", () => {
  it("leaves a foreign commit on top of the claim commit and reports the branch", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      const path = join(s.git.worktreeRoot(), TASK_1);
      // Someone commits on the branch right after the claim commit, then the claim fails.
      const office = new FailingOffice(s, () => {
        execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "foreign"], {
          cwd: path,
          env: repo.env,
        });
      });

      await caught(claimStory(s.deps({ office }), s.request(key)));

      expect(await subjects(repo.dir, repo.home, BRANCH_1, "main")).toEqual([
        `${TASK_1}: status In Progress`,
        "foreign",
      ]);
      expect(notices(s.office).map((n) => n.code)).toEqual([CLAIM_NOTICES.leftover]);
      expect(notices(s.office)[0]?.text).toContain("is not a commit this claim made");
    }, FIXTURE);
  });
});
