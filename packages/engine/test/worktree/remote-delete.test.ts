// The remote branch deletes of teardown and drop against a real temporary repository and its bare
// `origin` (0010; DIPO-348). Each delete carries a lease on the tip dipo pushed: when the remote
// branch moved after dipo's push, the delete is refused, the remote branch stays at the other tip
// and the outcome reports it. When dipo knows no tip it pushed (no local branch and, for teardown,
// no story PR head), the remote branch is kept and reported, never deleted blind.

import { describe, expect, it } from "bun:test";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import { git, type TempRepoWithRemote, withBareRemote } from "@dipsaus-orchestrator/testkit";

import {
  type ClaimOutcome,
  type ClaimRecord,
  claimStory,
  releaseForDrop,
  tearDown,
  TEARDOWN_NOTICES,
} from "../../src/worktree";

import {
  BACKLOG_FIXTURE,
  BRANCH_1,
  claimSetup,
  type ClaimSetup,
  inRemote,
  notices,
  publish,
} from "./helpers";

const FIXTURE = { fixture: BACKLOG_FIXTURE };

function claimed(outcome: ClaimOutcome): ClaimRecord {
  if (!outcome.ok) throw new Error(`expected a claim, got the skip ${outcome.reason}`);
  if (!outcome.pushed) throw new Error("expected the claim to push its branch");
  return outcome.claim;
}

/** The tip of `branch` on `origin`, or null. */
async function remoteTip(repo: TempRepoWithRemote, branch: string): Promise<string | null> {
  const listed = await inRemote(
    repo,
    "for-each-ref",
    "--format=%(objectname)",
    `refs/heads/${branch}`,
  );
  return listed.trim() || null;
}

/** Someone else pushes a commit on top of the branch's remote tip; returns it. */
async function moveRemote(repo: TempRepoWithRemote, from: string): Promise<string> {
  const tree = (await repo.git("rev-parse", `${from}^{tree}`)).trim();
  const theirs = (await repo.git("commit-tree", tree, "-p", from, "-m", "theirs")).trim();
  await repo.git("push", "--quiet", "origin", `${theirs}:refs/heads/${BRANCH_1}`);
  return theirs;
}

/** Removes the claim's worktree and its local branch by hand, as a crash or the maintainer may. */
async function dropLocal(repo: TempRepoWithRemote, claim: ClaimRecord): Promise<void> {
  await git(repo.dir, repo.home, "worktree", "unlock", claim.worktree);
  await git(repo.dir, repo.home, "worktree", "remove", "--force", claim.worktree);
  await repo.git("update-ref", "-d", `refs/heads/${BRANCH_1}`);
}

function deps(s: ClaimSetup) {
  return {
    officeId: s.office.officeId as OfficeId,
    office: s.office,
    git: s.git,
    clock: s.t.clock,
  };
}

const MERGED = { by: "merge-tree", tree: "t" } as const;

describe("remote branch deletes with a lease on the tip dipo pushed", () => {
  it("teardown: a remote branch that moved after dipo's push is kept and reported", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const claim = claimed(await claimStory(s.deps(), s.request(s.key())));
      const pushed = (await repo.git("rev-parse", BRANCH_1)).trim();
      const theirs = await moveRemote(repo, pushed);

      const outcome = await tearDown(deps(s), claim, MERGED, pushed);

      expect(outcome.ok).toBe(true);
      expect(outcome.ok ? outcome.remoteProblem : "").toContain("stale info");
      expect(await remoteTip(repo, BRANCH_1)).toBe(theirs);
      expect(await repo.git("branch", "--list", BRANCH_1)).toBe("");
      const told = notices(s.office).filter((n) => n.code === TEARDOWN_NOTICES.remoteBranch);
      expect(told).toHaveLength(1);
    }, FIXTURE);
  });

  it("teardown: without a local branch or a story PR head the remote branch is kept and reported", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const claim = claimed(await claimStory(s.deps(), s.request(s.key())));
      const pushed = (await repo.git("rev-parse", BRANCH_1)).trim();
      await dropLocal(repo, claim);

      const outcome = await tearDown(deps(s), claim, MERGED, null);

      expect(outcome).toEqual({
        ok: true,
        remoteProblem: `dipo knows no tip it pushed for ${BRANCH_1}, so it does not delete the remote branch`,
      });
      expect(await remoteTip(repo, BRANCH_1)).toBe(pushed);
      const told = notices(s.office).filter((n) => n.code === TEARDOWN_NOTICES.remoteBranch);
      expect(told).toHaveLength(1);
    }, FIXTURE);
  });

  it("teardown: at the tip dipo pushed, the remote branch is deleted", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const claim = claimed(await claimStory(s.deps(), s.request(s.key())));
      const pushed = (await repo.git("rev-parse", BRANCH_1)).trim();

      expect(await tearDown(deps(s), claim, MERGED, pushed)).toEqual({
        ok: true,
        remoteProblem: null,
      });
      expect(await remoteTip(repo, BRANCH_1)).toBeNull();
    }, FIXTURE);
  });

  it("drop: a remote branch that moved after dipo's push is kept and reported", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const claim = claimed(await claimStory(s.deps(), s.request(s.key())));
      const pushed = (await repo.git("rev-parse", BRANCH_1)).trim();
      const theirs = await moveRemote(repo, pushed);

      const outcome = await releaseForDrop(deps(s), claim, { deleteBranch: true });

      expect(outcome.ok).toBe(true);
      expect(outcome.ok ? outcome.remoteProblem : "").toContain("stale info");
      expect(await remoteTip(repo, BRANCH_1)).toBe(theirs);
      expect(await repo.git("branch", "--list", BRANCH_1)).toBe("");
    }, FIXTURE);
  });

  it("drop: without a local branch the remote branch is kept and reported", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const claim = claimed(await claimStory(s.deps(), s.request(s.key())));
      const pushed = (await repo.git("rev-parse", BRANCH_1)).trim();
      await dropLocal(repo, claim);

      const outcome = await releaseForDrop(deps(s), claim, { deleteBranch: true });

      expect(outcome).toEqual({
        ok: true,
        remoteProblem: `dipo knows no tip it pushed for ${BRANCH_1}, so it does not delete the remote branch`,
      });
      expect(await remoteTip(repo, BRANCH_1)).toBe(pushed);
    }, FIXTURE);
  });

  it("drop: at the tip dipo pushed, the remote and the local branch are deleted", async () => {
    await withBareRemote(async (repo) => {
      await publish(repo);
      const s = await claimSetup(repo);
      const claim = claimed(await claimStory(s.deps(), s.request(s.key())));

      expect(await releaseForDrop(deps(s), claim, { deleteBranch: true })).toEqual({
        ok: true,
        remoteProblem: null,
      });
      expect(await remoteTip(repo, BRANCH_1)).toBeNull();
      expect(await repo.git("branch", "--list", BRANCH_1)).toBe("");
    }, FIXTURE);
  });
});
