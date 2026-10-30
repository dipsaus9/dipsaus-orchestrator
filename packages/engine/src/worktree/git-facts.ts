// The git facts reconcile reads (0007 section 6 step 4, 0010 "A branch changed outside dipo"):
// `git worktree list --porcelain -z` and the local refs of claimed branches, read in one office git
// queue item. A story has no worktree (0010), so a hand change shows only in its branch: a live
// claim's branch tip is compared with the commits dipo recorded for it, the claim commit (or the
// start commit before it) and the head it last pushed for the story PR. dipo only ever adds commits
// on top of those, never rewrites them, so a tip that is gone or that no longer holds one of them
// changed by hand, and is listed as evidence. Worktrees whose directory is gone (prunable, or
// locked with the directory missing) are only reported: dipo never runs `git worktree unlock` or
// `git worktree prune` on them itself.

import { existsSync } from "node:fs";

import type { GitSession, OfficeGit } from "../git/office";
import { canonicalFuturePath } from "../git/paths";
import { findStoryPr } from "../story-pr/records";
import type { ClaimRecord } from "./records";
import type { OfficeHandle } from "../db/office";

/** One entry of `git worktree list --porcelain -z`. */
export interface ListedWorktree {
  /** Canonical path. */
  readonly path: string;
  readonly head: string | null;
  /** `refs/heads/<name>`, or null for a detached HEAD or a bare entry. */
  readonly branch: string | null;
  /** The reason git gives when the worktree is prunable, or null. */
  readonly prunable: string | null;
  /** The lock reason (`""` when locked without one), or null when not locked. */
  readonly locked: string | null;
}

/** A worktree git still lists whose directory is gone, and the commands that clear it. */
export interface GoneWorktree {
  readonly path: string;
  /** Why: git's prunable reason, or that a locked worktree's directory is missing. */
  readonly reason: string;
  /** True when git holds a lock on it, which must be removed before `git worktree prune`. */
  readonly locked: boolean;
}

/** The commands that clear `gone`: unlock each locked one, then prune once. */
export function clearCommands(gone: readonly GoneWorktree[]): string {
  return [
    ...gone.filter((w) => w.locked).map((w) => `git worktree unlock ${w.path}`),
    "git worktree prune",
  ].join(" && ");
}

/**
 * The listed worktrees whose directories are gone: those git marks `prunable`, and those that
 * are locked (dipo locks every run worktree) with the directory missing, which git never marks
 * prunable. dipo never prunes or unlocks them itself.
 */
export function goneWorktrees(
  worktrees: readonly ListedWorktree[],
  exists: (path: string) => boolean = existsSync,
): GoneWorktree[] {
  const gone: GoneWorktree[] = [];
  for (const w of worktrees) {
    if (w.prunable !== null) {
      gone.push({
        path: w.path,
        reason: w.prunable === "" ? "prunable" : w.prunable,
        locked: w.locked !== null,
      });
    } else if (w.locked !== null && !exists(w.path)) {
      gone.push({
        path: w.path,
        reason: `locked${w.locked === "" ? "" : ` (${w.locked})`}, its directory is missing`,
        locked: true,
      });
    }
  }
  return gone;
}

/** Parses `git worktree list --porcelain -z`. */
export function parseWorktreeList(output: string): ListedWorktree[] {
  const listed: ListedWorktree[] = [];
  let current: {
    path: string;
    head: string | null;
    branch: string | null;
    prunable: string | null;
    locked: string | null;
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
        locked: null,
      };
      continue;
    }
    if (current === null) continue;
    if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length);
    else if (field.startsWith("branch ")) current.branch = field.slice("branch ".length);
    else if (field === "prunable") current.prunable = "";
    else if (field.startsWith("prunable ")) current.prunable = field.slice("prunable ".length);
    else if (field === "locked") current.locked = "";
    else if (field.startsWith("locked ")) current.locked = field.slice("locked ".length);
  }
  flush();
  return listed;
}

/** What reconcile read from git for the office's live claims. */
export interface GitFacts {
  readonly worktrees: readonly ListedWorktree[];
  /** Evidence per claim run whose branch changed by hand; absent when unchanged. */
  readonly changed: ReadonlyMap<string, readonly string[]>;
}

/**
 * Reads the worktree list and checks the branch of every claim in `claims` against the commits
 * dipo recorded for it (`recordedCommits`), as one queue item.
 */
export function readGitFacts(
  git: OfficeGit,
  office: OfficeHandle,
  claims: readonly ClaimRecord[],
): Promise<GitFacts> {
  return git.run(async (session) => {
    const worktrees = parseWorktreeList(
      await session.ok(session.repository, ["worktree", "list", "--porcelain", "-z"]),
    );
    const changed = new Map<string, readonly string[]>();
    for (const claim of claims) {
      const evidence = await handChanges(session, claim, recordedCommits(office, claim));
      if (evidence.length > 0) changed.set(claim.runId, evidence);
    }
    return { worktrees, changed };
  });
}

/** A commit dipo recorded for a claim's branch, and what it is. */
export interface RecordedCommit {
  readonly sha: string;
  readonly what: string;
}

/**
 * The commits dipo recorded for the claim's branch: its claim commit (its start commit while the
 * claim has none) and the head it last pushed for the story PR of the claim's run.
 */
export function recordedCommits(office: OfficeHandle, claim: ClaimRecord): RecordedCommit[] {
  const recorded: RecordedCommit[] = [
    claim.claimSha === null
      ? { sha: claim.startSha, what: "the start commit" }
      : { sha: claim.claimSha, what: "the claim commit" },
  ];
  const pr = findStoryPr(office, claim.runId);
  if (pr !== null && pr.branch === claim.branch && pr.headSha !== "") {
    recorded.push({ sha: pr.headSha, what: `the head dipo pushed for PR #${pr.number}` });
  }
  return recorded;
}

/**
 * What changed by hand on the claim's branch since dipo recorded `recorded`, from the branch ref:
 * the branch is gone, or its tip no longer holds a recorded commit (a reset, a rebase or a forced
 * update). Empty when nothing changed.
 */
async function handChanges(
  session: GitSession,
  claim: ClaimRecord,
  recorded: readonly RecordedCommit[],
): Promise<string[]> {
  const ref = `refs/heads/${claim.branch}`;
  const tip = await session.step(session.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  if (tip.code !== 0) return [`the branch ${claim.branch} no longer exists`];
  const at = tip.stdout.trim();
  const evidence: string[] = [];
  for (const commit of recorded) {
    if (commit.sha === at) continue;
    const held = await session.step(session.repository, [
      "merge-base",
      "--is-ancestor",
      commit.sha,
      at,
    ]);
    if (held.code !== 0) {
      evidence.push(
        `the branch ${claim.branch} is at ${at}, which does not hold ${commit.what} ${commit.sha}`,
      );
    }
  }
  return evidence;
}
