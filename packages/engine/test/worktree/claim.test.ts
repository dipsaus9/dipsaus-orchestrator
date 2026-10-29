// Claiming a story against real temporary repositories, a bare remote and the pinned Backlog CLI
// (DIPO-38, DIPO-349; 0010 sections 2, 2a and 5): the branch, one claim commit of only the task
// file, no worktree of any kind; a lost race; collisions that delete nothing; the rollback of a
// claim that fails after its branch exists; and the ordering against the planning lane.
// The reuse of a released branch is in claim-reuse.test.ts; the slower cases run in CI only, in
// claim.ci.test.ts (DIPO-77, DIPO-79).

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { git, withBareRemote, withTempRepo } from "@dipsaus-orchestrator/testkit";

import { type GitCall, type GitResult, type GitSettings, spawnGitExec } from "../../src/git";
import { OfficeHandle } from "../../src/db/office";
import type { RunResult, SqlParams } from "../../src/platform/sqlite";
import { systemSpawn } from "../../src/platform/process";
import {
  CLAIM_NOTICES,
  claimStory,
  type ClaimOutcome,
  findClaim,
  hasLiveClaim,
  liveClaims,
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

/** A real executor that records every git call it runs. */
function recording(): { exec: (call: GitCall) => Promise<GitResult>; calls: GitCall[] } {
  const real = spawnGitExec(systemSpawn);
  const calls: GitCall[] = [];
  return {
    calls,
    exec: (call) => {
      calls.push(call);
      return real(call);
    },
  };
}

describe("claiming a story", () => {
  // The fast local version of the claim; the full one from origin/main with the push is in
  // claim.ci.test.ts (DIPO-79).
  it("claims without a remote from the local base: the branch and one claim commit of only the task file, no worktree; then skips its own live claim", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const main = (await repo.git("rev-parse", "HEAD")).trim();
      const s = await claimSetup(repo);
      const { exec, calls } = recording();
      const office = secondGit(repo, s, { remote: "origin", base: "main" }, exec);
      const key = s.key();
      const outcome = claimed(await claimStory(s.deps({ git: office }), s.request(key)));
      const claim = outcome.claim;
      expect(outcome.pushed).toBe(false);
      expect(claim.startSha).toBe(main);
      expect(claim.reused).toBe(false);
      expect(hasLiveClaim(s.office, key)).toBe(true);
      expect(await subjects(repo.dir, repo.home, BRANCH_1, "main")).toEqual([
        `${TASK_1}: status In Progress`,
      ]);
      const tip = (await repo.git("rev-parse", BRANCH_1)).trim();
      expect(claim.claimSha).toBe(tip);
      expect(await filesOf(repo.dir, repo.home, tip)).toEqual([TASK_FILE_1]);
      expect(await repo.git("show", `${tip}:${TASK_FILE_1}`)).toContain("status: In Progress");

      // No worktree: no `git worktree add`, no git call with a work tree, nothing under the root
      // but dipo's own folders (DIPO-349, 0010).
      expect(calls.some((call) => call.args.includes("worktree"))).toBe(false);
      expect(calls.every((call) => call.env["GIT_WORK_TREE"] === undefined)).toBe(true);
      expect(calls.every((call) => call.args.includes("--bare"))).toBe(true);
      expect(existsSync(join(s.git.worktreeRoot(), TASK_1))).toBe(false);
      expect(await repo.git("worktree", "list", "--porcelain")).not.toContain(TASK_1);
      expect((await repo.git("rev-parse", "HEAD")).trim()).toBe(main);
      expect(await repo.git("status", "--porcelain")).toBe("");
      expect(notices(s.office)).toEqual([]);

      // Its own live claim is skipped silently, and the ref tracked for this story is a collision
      // for another one, with a notice naming it. The full case with a remote is in
      // claim.ci.test.ts (DIPO-79).
      const again = await claimStory(s.deps(), s.request(key));
      expect(again).toEqual({ ok: false, reason: "notRunnable", notice: null, code: null });
      expect(notices(s.office)).toEqual([]);
      const other = await claimStory(s.deps(), s.request(s.key()));
      expect(other).toMatchObject({ ok: false, reason: "collision" });
      expect(other.ok ? "" : other.notice).toContain(`tracked for another story (${key})`);
      expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(tip);
      expect(liveClaims(s.office)).toHaveLength(1);
    }, FIXTURE);
  });

  it("lets one of two parallel claims of one branch win; the other skips and leaves nothing", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      // Both claims passed the empty `ls-remote` and wait at the branch's `update-ref` with an
      // empty old value until both reached it, then race for the ref (0010).
      let waiting = 0;
      const bothThere = Promise.withResolvers<void>();
      const real = spawnGitExec(systemSpawn);
      const exec = async (call: GitCall): Promise<GitResult> => {
        if (call.args.includes("update-ref") && call.args.at(-1) === "") {
          waiting += 1;
          if (waiting === 2) bothThere.resolve();
          await bothThere.promise;
        }
        return real(call);
      };
      const gitA = secondGit(repo, s, rootedAt("../a.worktrees"), exec);
      const gitB = secondGit(repo, s, rootedAt("../b.worktrees"), exec);
      const key = s.key();

      const [a, b] = await Promise.all([
        claimStory(s.deps({ git: gitA }), s.request(key)),
        claimStory(s.deps({ git: gitB }), s.request(key)),
      ]);

      const won = [a, b].filter((outcome) => outcome.ok);
      const lost = [a, b].filter((outcome) => !outcome.ok);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatchObject({
        ok: false,
        reason: "collision",
        code: CLAIM_NOTICES.lostRace,
      });
      expect(liveClaims(s.office)).toHaveLength(1);
      // The winner's branch was not overwritten: locally and on the remote it is its claim commit.
      const winner = claimed(won[0]!);
      expect(winner.pushed).toBe(true);
      expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(winner.claim.claimSha!);
      expect(await inRemote(repo, "ls-remote", "--heads", ".")).toContain(
        `${winner.claim.claimSha}\trefs/heads/${BRANCH_1}`,
      );
    }, FIXTURE);
  });
});

describe("claim collisions", () => {
  it("skips a local ref unknown to the engine as a collision and never deletes it", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      await repo.git("branch", BRANCH_1);
      const before = (await repo.git("rev-parse", BRANCH_1)).trim();

      const outcome = await claimStory(s.deps(), s.request(s.key()));

      expect(outcome).toMatchObject({
        ok: false,
        reason: "collision",
        code: CLAIM_NOTICES.collision,
      });
      expect(outcome.ok ? "" : outcome.notice).toContain("dipo did not create it");
      expect((await repo.git("rev-parse", BRANCH_1)).trim()).toBe(before);
      expect(liveClaims(s.office)).toEqual([]);
    }, FIXTURE);
  });

  it("skips a branch that exists only on the remote", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const other = await otherClone(repo);
      await git(other, repo.home, "push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH_1}`);
      const s = await claimSetup(repo);

      const outcome = await claimStory(s.deps(), s.request(s.key()));

      expect(outcome).toMatchObject({ ok: false, reason: "collision" });
      expect(outcome.ok ? "" : outcome.notice).toContain("on origin");
      expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
      expect(await inRemote(repo, "ls-remote", "--heads", ".")).toContain(BRANCH_1);
    }, FIXTURE);
  });

  it("claims past a folder at the old worktree path and leaves it alone (DIPO-349)", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const path = join(s.git.worktreeRoot(), TASK_1);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "keep.txt"), "mine\n");

      claimed(await claimStory(s.deps(), s.request(s.key())));

      expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("mine\n");
      expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(true);
    }, FIXTURE);
  });
});

/** An office handle whose write of the claim commit fails. */
class FailingOffice extends OfficeHandle {
  constructor(s: ClaimSetup) {
    super(s.t.state.connection, s.office.officeId);
  }

  override run(sql: string, params: SqlParams = {}): RunResult {
    if (sql.includes("claim_sha = coalesce") && params["claim_sha"] !== null) {
      throw new Error("injected database failure");
    }
    return super.run(sql, params);
  }
}

describe("a claim that fails after its branch exists", () => {
  it("rolls back a new branch that already holds the claim commit", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      const request = s.request(key);

      const error = await caught(claimStory(s.deps({ office: new FailingOffice(s) }), request));

      expect((error as Error).message).toContain("injected database failure");
      expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
      expect(findClaim(s.office, request.runId)?.releaseReason).toBe("claim-failed");
      expect(hasLiveClaim(s.office, key)).toBe(false);
      expect(notices(s.office)).toEqual([]);
      claimed(await claimStory(s.deps(), s.request(key)));
    }, FIXTURE);
  });

  it("rolls back a new branch when the setup fails, and the story can be claimed again", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      const request = s.request(key);

      const outcome = await claimStory(s.deps(), {
        ...request,
        setup: () => Promise.resolve({ ok: false, reason: "the box failed", log: "box: no" }),
      });

      expect(outcome).toMatchObject({
        ok: false,
        reason: "pickupCheckFailed",
        code: CLAIM_NOTICES.setupFailed,
        log: "box: no",
      });
      expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
      expect(findClaim(s.office, request.runId)?.releaseReason).toBe("setup-failed");
      claimed(await claimStory(s.deps(), s.request(key)));
    }, FIXTURE);
  });
});

describe("the claim and the planning lane in the office git queue", () => {
  it("skips a story whose lane-b operation was journaled first", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      await laneOf(s).journal({
        kind: "edit",
        key,
        subject: TASK_1,
        target: { status: "Refined" },
      });

      const outcome = await claimStory(s.deps(), s.request(key));

      expect(outcome).toMatchObject({
        ok: false,
        reason: "notRunnable",
        code: CLAIM_NOTICES.pendingLaneOp,
      });
      expect(outcome.ok ? "" : outcome.notice).toContain("pending backlog PR");
      expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
    }, FIXTURE);
  });

  it("returns the pickup re-check's skip before anything is created", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const outcome = await claimStory(s.deps(), {
        ...s.request(s.key()),
        recheck: () => ({ ok: false, reason: "pickupCheckFailed", notice: "R15", code: "gate" }),
      });
      expect(outcome).toMatchObject({ ok: false, reason: "pickupCheckFailed" });
      expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
    }, FIXTURE);
  });
});
