// The git facts reconcile reads (0007 section 6 step 4, 0010 section 7 "Worktree or branch changed
// by hand"): `git worktree list --porcelain -z` and the local refs of claimed branches, read in one
// office git queue item. A live claim's worktree and branch are compared with what the claim
// recorded; anything changed by hand is listed as evidence. Prunable worktrees are only reported:
// dipo never runs `git worktree prune` itself.

import { existsSync } from "node:fs";

import type { GitSession, OfficeGit } from "../git/office";
import { canonicalFuturePath } from "../git/paths";
import { changedLinks } from "../git/snapshot";
import type { ClaimRecord } from "../worktree/records";

/** One entry of `git worktree list --porcelain -z`. */
export interface ListedWorktree {
  /** Canonical path. */
  readonly path: string;
  readonly head: string | null;
  /** `refs/heads/<name>`, or null for a detached HEAD or a bare entry. */
  readonly branch: string | null;
  /** The reason git gives when the worktree is prunable, or null. */
  readonly prunable: string | null;
}

/** Parses `git worktree list --porcelain -z`. */
export function parseWorktreeList(output: string): ListedWorktree[] {
  const listed: ListedWorktree[] = [];
  let current: {
    path: string;
    head: string | null;
    branch: string | null;
    prunable: string | null;
  } | null = null;
  const flush = () => {
    if (current !== null) listed.push(current);
    current = null;
  };
  for (const field of output.split("\0")) {
    if (field === "") {
      flush();
      continue;
    }
    if (field.startsWith("worktree ")) {
      flush();
      current = {
        path: canonicalFuturePath(field.slice("worktree ".length)),
        head: null,
        branch: null,
        prunable: null,
      };
      continue;
    }
    if (current === null) continue;
    if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length);
    else if (field.startsWith("branch ")) current.branch = field.slice("branch ".length);
    else if (field === "prunable") current.prunable = "";
    else if (field.startsWith("prunable ")) current.prunable = field.slice("prunable ".length);
  }
  flush();
  return listed;
}

/** What reconcile read from git for the office's live claims. */
export interface GitFacts {
  readonly worktrees: readonly ListedWorktree[];
  /** Evidence per claim run whose worktree or branch changed by hand; absent when unchanged. */
  readonly changed: ReadonlyMap<string, readonly string[]>;
}

/** Reads the worktree list and checks every claim in `claims` against it, as one queue item. */
export function readGitFacts(git: OfficeGit, claims: readonly ClaimRecord[]): Promise<GitFacts> {
  return git.run(async (session) => {
    const worktrees = parseWorktreeList(
      await session.ok(session.repository, ["worktree", "list", "--porcelain", "-z"]),
    );
    const changed = new Map<string, readonly string[]>();
    for (const claim of claims) {
      const evidence = await handChanges(session, claim, worktrees);
      if (evidence.length > 0) changed.set(claim.runId, evidence);
    }
    return { worktrees, changed };
  });
}

/** What changed by hand in the claim's worktree and branch since the claim; empty when nothing. */
async function handChanges(
  session: GitSession,
  claim: ClaimRecord,
  worktrees: readonly ListedWorktree[],
): Promise<string[]> {
  const evidence: string[] = [];
  const ref = `refs/heads/${claim.branch}`;
  const tip = await session.step(session.repository, ["rev-parse", "--verify", "--quiet", ref]);
  if (tip.code !== 0) evidence.push(`the branch ${claim.branch} no longer exists`);
  if (!existsSync(claim.worktree)) {
    evidence.push(`the worktree ${claim.worktree} is gone`);
    return evidence;
  }
  const links = changedLinks(claim.snapshot);
  if (links.length > 0) {
    evidence.push(`the git links of ${claim.worktree} changed (${links.join(", ")})`);
  }
  const listed = worktrees.find((entry) => entry.path === canonicalFuturePath(claim.worktree));
  if (listed === undefined) {
    evidence.push(`${claim.worktree} is no longer a worktree of the repository`);
  } else if (listed.branch !== ref) {
    const what =
      listed.branch === null
        ? "a detached HEAD"
        : listed.branch.replace(/^refs\/heads\//, "the branch ");
    evidence.push(`${claim.worktree} has ${what} checked out, not ${claim.branch}`);
  }
  return evidence;
}
