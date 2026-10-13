// Claiming a story against real temporary repositories, a bare remote and the pinned Backlog CLI
// (DIPO-38; 0010 sections 2, 2a and 7, 0008 section 2): the branch, the locked worktree, one claim
// commit and the remote ref; a lost race; collisions that delete nothing; the reuse of a released
// branch with the base merged in; the free-space check; the ordering against the planning lane;
// and the refusal of git calls in a worktree whose git links changed.
// The slower cases run in CI only, in claim.ci.test.ts (DIPO-77, DIPO-79).

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { git, withBareRemote, withTempRepo } from "@dipsaus-orchestrator/testkit";

import {
  type GitCall,
  GitError,
  type GitResult,
  type GitSettings,
  spawnGitExec,
} from "../../src/git";
import { OfficeHandle } from "../../src/db/office";
import type { OfficeLoadContext } from "../../src/office/steps";
import type { RunResult, SqlParams } from "../../src/platform/sqlite";
import { systemSpawn } from "../../src/platform/process";
import {
  CLAIM_NOTICES,
  claimStory,
  type ClaimOutcome,
  findClaim,
  hasLiveClaim,
  liveClaims,
  StoryClaims,
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

describe("claiming a story", () => {
  // The fast local version of the claim; the full one from origin/main with the push is in
  // claim.ci.test.ts (DIPO-79).
  it("claims without a remote from the local base: a locked worktree, one claim commit of only the task file, no push; then skips its own live claim", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const main = (await repo.git("rev-parse", "HEAD")).trim();
      const s = await claimSetup(repo);
      const key = s.key();
      const request = s.request(key);
      const outcome = claimed(await claimStory(s.deps(), request));
      const claim = outcome.claim;
      expect(outcome.pushed).toBe(false);
      expect(claim.worktree).toBe(join(s.git.worktreeRoot(), TASK_1));
      expect(claim.startSha).toBe(main);
      expect(claim.reused).toBe(false);
      expect(hasLiveClaim(s.office, key)).toBe(true);
      expect(await subjects(repo.dir, repo.home, BRANCH_1, "main")).toEqual([
        `${TASK_1}: status In Progress`,
      ]);
      const tip = (await repo.git("rev-parse", BRANCH_1)).trim();
      expect(claim.claimSha).toBe(tip);
      expect(await filesOf(repo.dir, repo.home, tip)).toEqual([TASK_FILE_1]);
      expect(readFileSync(join(claim.worktree, TASK_FILE_1), "utf8")).toContain(
        "status: In Progress",
      );
      const entry = (await repo.git("worktree", "list", "--porcelain"))
        .split("\n\n")
        .find((block) => block.includes(`worktree ${claim.worktree}`));
      expect(entry).toContain(`locked dipo ${request.runId}`);
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
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      // Both claims wait at `git worktree add` until both reached it, then race for the ref.
      let waiting = 0;
      const bothThere = Promise.withResolvers<void>();
      const real = spawnGitExec(systemSpawn);
      const exec = async (call: GitCall): Promise<GitResult> => {
        if (call.args.includes("worktree") && call.args.includes("add")) {
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
      const loserPath = join((a.ok ? gitB : gitA).worktreeRoot(), TASK_1);
      expect(existsSync(loserPath)).toBe(false);
      expect(liveClaims(s.office)).toHaveLength(1);
      const list = await repo.git("worktree", "list", "--porcelain");
      expect(list).not.toContain(loserPath);
    }, FIXTURE);
  });

  it("skips the claim as notRunnable and creates nothing when less than 2 GB are free", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      const outcome = await claimStory(
        s.deps({ disk: { freeBytes: () => Promise.resolve(1_000_000_000) } }),
        s.request(key),
      );
      expect(outcome).toMatchObject({
        ok: false,
        reason: "notRunnable",
        code: CLAIM_NOTICES.lowDisk,
      });
      expect(outcome.ok ? "" : outcome.notice).toContain("1.0 GB free");
      expect(notices(s.office).map((n) => n.code)).toEqual([CLAIM_NOTICES.lowDisk]);
      expect(existsSync(s.git.worktreeRoot())).toBe(false);
      expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
      expect(await inRemote(repo, "ls-remote", "--heads", ".")).not.toContain(BRANCH_1);
      expect(liveClaims(s.office)).toEqual([]);
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
      expect(existsSync(join(s.git.worktreeRoot(), TASK_1))).toBe(false);
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

  it("skips an existing worktree path and leaves the directory alone", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const path = join(s.git.worktreeRoot(), TASK_1);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "keep.txt"), "mine\n");

      const outcome = await claimStory(s.deps(), s.request(s.key()));

      expect(outcome).toMatchObject({
        ok: false,
        reason: "collision",
        code: CLAIM_NOTICES.pathExists,
      });
      expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("mine\n");
      expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
      expect(liveClaims(s.office)).toEqual([]);
    }, FIXTURE);
  });
});

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

function failingOffice(s: ClaimSetup, before: () => void = () => {}): OfficeHandle {
  return new FailingOffice(s, before);
}

describe("a claim that fails after the worktree exists", () => {
  it("rolls back a new branch that already holds the claim commit", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      const request = s.request(key);

      const error = await caught(claimStory(s.deps({ office: failingOffice(s) }), request));

      expect((error as Error).message).toContain("injected database failure");
      expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
      expect(existsSync(join(s.git.worktreeRoot(), TASK_1))).toBe(false);
      expect(findClaim(s.office, request.runId)?.releaseReason).toBe("claim-failed");
      expect(hasLiveClaim(s.office, key)).toBe(false);
      expect(notices(s.office)).toEqual([]);
      claimed(await claimStory(s.deps(), s.request(key)));
    }, FIXTURE);
  });

  it("keeps the branch while the worktree could not be removed", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const key = s.key();
      const broken = secondGit(
        repo,
        s,
        rootedAt("../repo.worktrees"),
        failing(
          (args) =>
            args.includes("status") || (args.includes("worktree") && args.includes("remove")),
        ),
      );

      await caught(claimStory(s.deps({ git: broken }), s.request(key)));

      const path = join(s.git.worktreeRoot(), TASK_1);
      expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(true);
      expect(await repo.git("worktree", "list", "--porcelain")).toContain(`worktree ${path}`);
      expect(notices(s.office)[0]?.text).toContain("could not be removed");
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
      expect(existsSync(join(s.git.worktreeRoot(), TASK_1))).toBe(false);
      expect(await refExists(repo.dir, repo.home, `refs/heads/${BRANCH_1}`)).toBe(false);
    }, FIXTURE);
  });
});

describe("the worktree snapshot", () => {
  const LINKS = ["commondir", "gitdir", "pointer"] as const;

  it("refuses every engine git call in the worktree once its commondir, gitdir or .git pointer changed", async () => {
    await withTempRepo(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const claim = claimed(await claimStory(s.deps(), s.request(s.key()))).claim;
      const location = s.git.worktreeLocation(claim.worktree);
      for (const link of LINKS) {
        const file =
          link === "pointer" ? join(claim.worktree, ".git") : join(claim.snapshot.adminDir, link);
        const original = readFileSync(file, "utf8");

        // Planted: a pointer at another git dir, an admin dir pointing elsewhere.
        writeFileSync(file, `${original.trimEnd()}-planted\n`);
        const status = await caught(s.git.run((g) => g.ok(location, ["status", "--porcelain"])));
        expect(status).toBeInstanceOf(GitError);
        expect((status as GitError).code).toBe("git.worktreeTampered");
        expect((status as GitError).details["changed"]).toEqual([link]);
        expect(() => s.git.worktreeLocation(claim.worktree)).toThrow(/changed since dipo claimed/);

        // After a daemon restart the snapshot comes back from the claim record.
        const restarted = secondGit(repo, s, { remote: "origin", base: "main" });
        const claims = new StoryClaims({ git: () => restarted, cli: s.cli });
        expect(
          claims.attach({
            officeId: s.office.officeId,
            office: s.office,
            clock: s.t.clock,
          } as unknown as OfficeLoadContext),
        ).toBeNull();
        const again = await caught(restarted.run((g) => g.ok(location, ["status", "--porcelain"])));
        expect((again as GitError).code).toBe("git.worktreeTampered");

        // Restored, git runs again.
        writeFileSync(file, original);
        expect(await s.git.run((g) => g.ok(location, ["status", "--porcelain"]))).toBe("");
      }
    }, FIXTURE);
  });
});
