// Fast local cases of the claim rules whose full versions run in CI only (claim.ci.test.ts,
// DIPO-77): the reuse of a released branch at its kept tip, a reused branch moved back to its kept
// tip when the claim fails after its claim commit, and a foreign commit on the claim commit left
// over with a notice (DIPO-38, DIPO-349; 0010 sections 2 and 2a). No remote: the base is the local
// `main`, so nothing is cloned, pushed or fetched, and the released branch is made by hand instead
// of by a first claim.

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { StoryKey } from "@dipsaus-orchestrator/contract";
import { type TempRepo, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { OfficeHandle } from "../../src/db/office";
import type { RunResult, SqlParams } from "../../src/platform/sqlite";
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
 * holds one work commit on the base and the release is recorded. Returns the kept tip.
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

/** Runs git in the repository synchronously, as a hook inside a database write must. */
function gitSync(repo: TempRepo, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo.dir, env: repo.env, encoding: "utf8" }).trim();
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
  it("reuses it at its kept tip, for dipo's catch-up to merge the base later", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      const kept = await releasedBranch(repo, s, key, "shared.txt", "branch\n");
      const base = await commitOnBase(repo, "shared.txt", "base\n");

      const claim = claimed(await claimStory(s.deps(), s.request(key))).claim;

      expect(claim.reused).toBe(true);
      expect(claim.startSha).toBe(kept);
      expect(claim.baseSha).toBe(base);
      expect(releasedBranchFor(s.office, key, BRANCH_1)).toBeNull();
      // Only the claim commit lies on the kept tip: no merge of the base, no conflict to abort.
      expect((await repo.git("rev-parse", `${BRANCH_1}^`)).trim()).toBe(kept);
      expect(await subjects(repo.dir, repo.home, BRANCH_1, kept)).toEqual([
        `${TASK_1}: status In Progress`,
      ]);
      expect(await filesOf(repo.dir, repo.home, claim.claimSha as string)).toEqual([TASK_FILE_1]);
      expect(await repo.git("show", `${BRANCH_1}:shared.txt`)).toBe("branch\n");
      expect(notices(s.office)).toEqual([]);
    }, FIXTURE);
  });

  it("moves a reused branch back to its kept tip when the claim fails after its claim commit, and reopens the release", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      const kept = await releasedBranch(repo, s, key, "work.txt", "work\n");
      const request = s.request(key);

      await caught(claimStory(s.deps({ office: new FailingOffice(s, () => {}) }), request));

      expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(kept);
      expect(releasedBranchFor(s.office, key, BRANCH_1)).not.toBeNull();
      expect(findClaim(s.office, request.runId)?.releaseReason).toBe("claim-failed");
      expect(notices(s.office)).toEqual([]);

      const again = claimed(await claimStory(s.deps(), s.request(key))).claim;
      expect(again.reused).toBe(true);
      expect(again.startSha).toBe(kept);
    }, FIXTURE);
  });
});

describe("a claim that fails after its claim commit", () => {
  it("leaves a foreign commit on top of the claim commit and reports the branch, which the next claim keeps as left over", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      // Someone commits on the branch right after the claim commit, then the claim fails.
      const office = new FailingOffice(s, () => {
        const tip = gitSync(repo, "rev-parse", BRANCH_1);
        const foreign = gitSync(repo, "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "foreign");
        gitSync(repo, "update-ref", `refs/heads/${BRANCH_1}`, foreign, tip);
      });

      await caught(claimStory(s.deps({ office }), s.request(key)));

      expect(await subjects(repo.dir, repo.home, BRANCH_1, "main")).toEqual([
        `${TASK_1}: status In Progress`,
        "foreign",
      ]);
      expect(notices(s.office).map((n) => n.code)).toEqual([CLAIM_NOTICES.leftover]);
      expect(notices(s.office)[0]?.text).toContain("is not a commit this claim made");
      const tip = (await repo.git("rev-parse", BRANCH_1)).trim();

      // The next claim names the branch as left over and keeps it.
      const again = await claimStory(s.deps(), s.request(key));

      expect(again).toMatchObject({ ok: false, reason: "collision" });
      expect(again.ok ? "" : again.notice).toContain(
        "left over from an earlier failed claim of this story",
      );
      expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(tip);
    }, FIXTURE);
  });
});
