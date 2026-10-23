// Releasing a claim for `story.drop` (DIPO-160; 0020 section 8, 0010 section 2a). The claim's
// worktree is removed and its release written:
// - without `deleteBranch` the worktree goes with `git worktree remove` (a dirty one is refused,
//   and the caller listed its files first), the branch is kept and recorded as released for the
//   story;
// - with `deleteBranch` the worktree goes with `--force`, the branch is deleted locally and on the
//   remote, and nothing is recorded as released. Clients ask for the typed story id first
//   (`irreversibleWhen: ["deleteBranch"]`).
// Both are one item of the office git queue; the claim row is released after the git steps, and
// every step is idempotent, so a re-run finishes what a crash left.
//
// `work.discard` (DIPO-161) releases the same way with `--force`, and deletes the remote branch only
// when every commit on its tip is on the local branch or on the base (`deleteOwnBranch`), so no
// remote commit goes unlisted; `removeLeftovers` removes what a story Done elsewhere left behind.

import { existsSync } from "node:fs";

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import { forgetContextPack } from "../context/pack";
import type { OfficeHandle } from "../db/office";
import { FETCH_CONFIG } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { EXTERNAL_STEP_TIMEOUT_MS, type GitResult, isTimedOut } from "../git/runner";
import { repoOfRemoteUrl } from "../platform/host";
import { forgetWorkerNotes } from "../prompts/notes";

import {
  claimLockReason,
  dirtyFiles,
  lockOf,
  remoteRefMissing,
  removeWorktree,
  remoteUrl,
} from "./teardown";
import { type ClaimRecord, markReclaimed, type ReleasedBranch, releaseClaim } from "./records";
import type { SlotTable } from "./slots";

/** The release reason of a claim `story.drop` released. */
export const DROP_RELEASE_REASON = "drop";

export interface DropReleaseDeps {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly clock: Clock;
  readonly slots?: SlotTable;
}

export type DropReleaseOutcome =
  | {
      readonly ok: true;
      /** Why the remote branch may still exist after `deleteBranch`, or null. */
      readonly remoteProblem: string | null;
    }
  | { readonly ok: false; readonly why: string; readonly files: readonly string[] };

/**
 * The files `git status` lists in the claim's worktree (uncommitted and untracked); empty when it
 * is clean, gone or unreadable. Its own queue item.
 */
export function dirtyFilesOf(
  deps: Pick<DropReleaseDeps, "git">,
  claim: Pick<ClaimRecord, "worktree" | "branch" | "startSha">,
): Promise<string[]> {
  return deps.git.run(async (git) => {
    if (deps.git.adminDirOf(claim.worktree) === null) return [];
    return dirtyFiles(deps, git, claim);
  });
}

/** Releases the claim as `story.drop` does; see the file comment. */
export async function releaseForDrop(
  deps: DropReleaseDeps,
  claim: ClaimRecord,
  options: { readonly deleteBranch: boolean },
): Promise<DropReleaseOutcome> {
  const outcome = await deps.git.run(async (git): Promise<DropReleaseOutcome> => {
    const worktree = options.deleteBranch
      ? await forceRemoveWorktree(deps, git, claim)
      : await removeWorktree(deps, git, claim);
    if (!worktree.ok) return worktree;
    if (!options.deleteBranch) return { ok: true, remoteProblem: null };
    return deleteBranches(deps, git, claim);
  });
  if (!outcome.ok) return outcome;
  deps.office.immediate(() => {
    releaseClaim(deps.office, claim.runId, {
      at: deps.clock.now(),
      reason: DROP_RELEASE_REASON,
      keepBranch: !options.deleteBranch,
    });
    forgetWorkerNotes(deps.office, claim.worktree);
    forgetContextPack(deps.office, claim.worktree);
  });
  deps.slots?.free(claim.worktree);
  return outcome;
}

/** `git worktree remove --force`: what is lost is the caller's confirmed loss list. */
async function forceRemoveWorktree(
  deps: DropReleaseDeps,
  git: GitSession,
  claim: Pick<ClaimRecord, "runId" | "worktree">,
): Promise<{ readonly ok: true } | { readonly ok: false; why: string; files: string[] }> {
  const path = claim.worktree;
  if (deps.git.adminDirOf(path) === null) {
    if (existsSync(path)) {
      return {
        ok: false,
        why: `${path} exists but is no longer a worktree of this repository, so dipo leaves it alone`,
        files: [],
      };
    }
    deps.git.unpinWorktree(path);
    return { ok: true };
  }
  const ours = claimLockReason(claim.runId);
  const lock = await lockOf(git, path);
  if (lock !== null && lock !== ours) {
    return {
      ok: false,
      why: `the worktree ${path} is locked by someone else (${lock === "" ? "no reason given" : lock})`,
      files: [],
    };
  }
  if (lock === ours) await git.ok(git.repository, ["worktree", "unlock", path]);
  const removed = await git.step(git.repository, ["worktree", "remove", "--force", path]);
  if (removed.code !== 0) {
    if (lock === ours) await git.step(git.repository, ["worktree", "lock", "--reason", ours, path]);
    return {
      ok: false,
      why: `git refused to remove the worktree ${path} (${removed.stderr.trim() || `exit ${removed.code}`})`,
      files: [],
    };
  }
  deps.git.unpinWorktree(path);
  return { ok: true };
}

/**
 * `story.drop` with `deleteBranch` and no live claim (DIPO-228): deletes each branch the story's
 * open releases keep, locally and on the remote, and marks each release reclaimed, so no later
 * claim reuses a deleted branch. A branch that fails stops the loop; the ones before it stay done.
 */
export async function deleteKeptBranches(
  deps: DropReleaseDeps,
  released: readonly ReleasedBranch[],
): Promise<DropReleaseOutcome> {
  return deps.git.run(async (git): Promise<DropReleaseOutcome> => {
    const problems: string[] = [];
    for (const release of released) {
      const deleted = await deleteBranches(deps, git, { branch: release.branch });
      if (!deleted.ok) return deleted;
      deps.office.immediate(() => markReclaimed(deps.office, release, deps.clock.now(), null));
      if (deleted.remoteProblem !== null)
        problems.push(`${release.branch}: ${deleted.remoteProblem}`);
    }
    return { ok: true, remoteProblem: problems.length === 0 ? null : problems.join("; ") };
  });
}

// ---- discard (DIPO-161) ------------------------------------------------------------------------

/** The release reason of a claim `work.discard` released. */
export const DISCARD_RELEASE_REASON = "discard";

export type DiscardBranchOutcome =
  | {
      readonly ok: true;
      /** Why the remote branch may still exist although dipo tried to delete it, or null. */
      readonly remoteProblem: string | null;
      /**
       * The remote branch tip dipo kept because it holds commits that are neither on the local
       * branch nor on the base, or null: the remote branch is gone, was deleted, or the office has
       * no remote.
       */
      readonly remoteKept: string | null;
    }
  | { readonly ok: false; readonly why: string; readonly files: readonly string[] };

/**
 * Releases the claim as `work.discard` does (0020 section 8): the worktree goes with `--force` (the
 * client listed what is lost and asked for the typed story id first), the branch is deleted locally
 * and on the remote when nothing there is missing from the local branch or the base
 * (`deleteOwnBranch`); nothing is recorded as released. The claim is released as `discard`, its
 * tier T rows are forgotten and its port slot is freed. One queue item for the git steps; every
 * step is idempotent.
 */
export async function releaseForDiscard(
  deps: DropReleaseDeps,
  claim: ClaimRecord,
): Promise<DiscardBranchOutcome> {
  const outcome = await deps.git.run(async (git): Promise<DiscardBranchOutcome> => {
    const worktree = await forceRemoveWorktree(deps, git, claim);
    if (!worktree.ok) return worktree;
    return deleteOwnBranch(deps, git, claim.branch, claim.base);
  });
  if (!outcome.ok) return outcome;
  deps.office.immediate(() => {
    releaseClaim(deps.office, claim.runId, {
      at: deps.clock.now(),
      reason: DISCARD_RELEASE_REASON,
      keepBranch: false,
    });
    forgetWorkerNotes(deps.office, claim.worktree);
    forgetContextPack(deps.office, claim.worktree);
  });
  deps.slots?.free(claim.worktree);
  return outcome;
}

/** What `work.discard` removes of the leftovers of a story Done elsewhere (0020 section 10). */
export interface LeftoverTargets {
  /** The worktrees kept as leftovers (a removed one is fine), by the run that claimed them. */
  readonly worktrees: readonly Pick<ClaimRecord, "runId" | "worktree" | "branch" | "startSha">[];
  /** The open releases of the story; each is marked reclaimed once its branch is deleted. */
  readonly branches: readonly ReleasedBranch[];
  /** Branches without a release row: those of leftovers not yet settled, or of a crashed teardown. */
  readonly loose: readonly string[];
  /** The base branch name, for the remote-branch check. */
  readonly base: string;
}

/** The branch names `removeLeftovers` deletes for `targets`, each once, in order. */
export function leftoverBranchNames(
  targets: Pick<LeftoverTargets, "branches" | "loose">,
): string[] {
  return [...new Set([...targets.branches.map((release) => release.branch), ...targets.loose])];
}

/**
 * `work.discard` of what released claims left behind (the leftovers of a story Done elsewhere,
 * 0020 section 10): each kept worktree goes with `--force`, and each branch of
 * `leftoverBranchNames` is deleted locally and, under `deleteOwnBranch`'s rule, on the remote; each
 * release row is marked reclaimed.
 */
export async function removeLeftovers(
  deps: DropReleaseDeps,
  targets: LeftoverTargets,
): Promise<DiscardBranchOutcome> {
  return deps.git.run(async (git): Promise<DiscardBranchOutcome> => {
    for (const worktree of targets.worktrees) {
      const removed = await forceRemoveWorktree(deps, git, worktree);
      if (!removed.ok) return removed;
    }
    const problems: string[] = [];
    const kept: string[] = [];
    for (const branch of leftoverBranchNames(targets)) {
      const deleted = await deleteOwnBranch(deps, git, branch, targets.base);
      if (!deleted.ok) return deleted;
      for (const release of targets.branches.filter((r) => r.branch === branch)) {
        deps.office.immediate(() => markReclaimed(deps.office, release, deps.clock.now(), null));
      }
      if (deleted.remoteProblem !== null) problems.push(`${branch}: ${deleted.remoteProblem}`);
      if (deleted.remoteKept !== null) kept.push(`${branch} at ${deleted.remoteKept}`);
    }
    return {
      ok: true,
      remoteProblem: problems.length === 0 ? null : problems.join("; "),
      remoteKept: kept.length === 0 ? null : kept.join("; "),
    };
  });
}

/** What `remoteBranchOf` found of a branch on the remote. */
export type RemoteBranch =
  /** No remote, or the remote has no such branch. */
  | { readonly kind: "none" }
  /** The remote could not be read. */
  | { readonly kind: "unread"; readonly problem: string }
  /**
   * The remote tip. `covered` is true when every commit on it is on the local branch or on the
   * base, so deleting it loses nothing the caller has not listed or the base does not have.
   */
  | { readonly kind: "tip"; readonly tip: string; readonly covered: boolean };

/**
 * The remote branch of `branch` and whether its tip is covered: the tip is in the repository and
 * either the local tip, an ancestor of it, or (also without a local branch) a commit that adds
 * nothing to the base (`git merge-tree`). A tip someone else pushed is not covered.
 */
export async function remoteBranchOf(
  deps: Pick<DropReleaseDeps, "git">,
  git: GitSession,
  branch: string,
  local: string | null,
  base: string,
): Promise<RemoteBranch> {
  const { remote } = deps.git.settings;
  if ((await remoteUrl(git, remote)) === null) return { kind: "none" };
  const listed = await external(git, ["ls-remote", remote, `refs/heads/${branch}`]);
  if (listed.code !== 0) {
    return {
      kind: "unread",
      problem: `dipo could not read the remote branch (${listed.stderr.trim() || `exit ${listed.code}`})`,
    };
  }
  const tip = listed.stdout.trim().split(/\s+/)[0] ?? "";
  if (tip === "") return { kind: "none" };
  return { kind: "tip", tip, covered: await covered(deps, git, tip, local, base) };
}

/**
 * Deletes the local branch, then the remote's only when its tip is covered (`remoteBranchOf`): a
 * remote tip with commits that are neither on the local branch nor on the base, such as a commit
 * someone added on the host, keeps the remote branch (`remoteKept`). The delete is pushed with a
 * lease on the tip it judged, so a push that lands in between is never deleted.
 */
export async function deleteOwnBranch(
  deps: Pick<DropReleaseDeps, "git">,
  git: GitSession,
  branch: string,
  base: string,
): Promise<DiscardBranchOutcome> {
  const ref = `refs/heads/${branch}`;
  const local = await revParseCommit(git, ref);
  // Judged before the local branch goes: the ancestor check needs its tip.
  const found = await remoteBranchOf(deps, git, branch, local, base);
  if (local !== null) {
    const deleted = await git.step(git.repository, ["update-ref", "-d", ref, local]);
    if (deleted.code !== 0) {
      return {
        ok: false,
        why: `deleting the branch ${branch} failed (${deleted.stderr.trim() || `exit ${deleted.code}`})`,
        files: [],
      };
    }
    await git.step(git.repository, ["config", "--remove-section", `branch.${branch}`]);
  }
  if (found.kind === "none") return { ok: true, remoteProblem: null, remoteKept: null };
  if (found.kind === "unread") return { ok: true, remoteProblem: found.problem, remoteKept: null };
  if (!found.covered) return { ok: true, remoteProblem: null, remoteKept: found.tip };
  const pushed = await external(git, [
    "push",
    "--quiet",
    "--no-verify",
    `--force-with-lease=${ref}:${found.tip}`,
    deps.git.settings.remote,
    "--delete",
    branch,
  ]);
  if (pushed.code === 0 || remoteRefMissing(pushed.stderr)) {
    return { ok: true, remoteProblem: null, remoteKept: null };
  }
  return {
    ok: true,
    remoteProblem: pushed.stderr.trim() || `exit ${pushed.code}`,
    remoteKept: null,
  };
}

/** See `remoteBranchOf`. */
async function covered(
  deps: Pick<DropReleaseDeps, "git">,
  git: GitSession,
  tip: string,
  local: string | null,
  base: string,
): Promise<boolean> {
  const present = await git.step(git.repository, ["cat-file", "-e", `${tip}^{commit}`]);
  if (present.code !== 0) return false;
  if (local !== null) {
    if (tip === local) return true;
    const ancestor = await git.step(git.repository, ["merge-base", "--is-ancestor", tip, local]);
    if (ancestor.code === 0) return true;
  }
  return addsNothingTo(git, await baseRefIn(deps, git, base), tip);
}

/** `refs/remotes/<remote>/<base>` when the repository has it, else `refs/heads/<base>`. */
export async function baseRefIn(
  deps: Pick<DropReleaseDeps, "git">,
  git: GitSession,
  base: string,
): Promise<string> {
  const remote = `refs/remotes/${deps.git.settings.remote}/${base}`;
  return (await revParseCommit(git, remote)) === null ? `refs/heads/${base}` : remote;
}

/** True when `git merge-tree --write-tree <baseRef> <rev>` prints the base's tree. */
export async function addsNothingTo(
  git: GitSession,
  baseRef: string,
  rev: string,
): Promise<boolean> {
  const baseTree = await git.step(git.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${baseRef}^{tree}`,
  ]);
  if (baseTree.code !== 0) return false;
  const merged = await git.step(git.repository, ["merge-tree", "--write-tree", baseRef, rev]);
  if (merged.code !== 0) return false;
  const out = merged.stdout;
  const end = out.indexOf("\n");
  return (end === -1 ? out : out.slice(0, end)).trim() === baseTree.stdout.trim();
}

/** A git step that reaches the remote: hardened config and the external deadline. */
function external(git: GitSession, args: readonly string[]): Promise<GitResult> {
  return git
    .step(git.repository, [...args], { config: FETCH_CONFIG, timeoutMs: EXTERNAL_STEP_TIMEOUT_MS })
    .catch((error: unknown): GitResult => {
      if (isTimedOut(error)) return { code: null, stdout: "", stderr: error.message };
      throw error;
    });
}

async function revParseCommit(git: GitSession, ref: string): Promise<string | null> {
  const found = await git.step(git.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return found.code === 0 ? found.stdout.trim() || null : null;
}

/** The `[HOST/]OWNER/REPO` of a PR URL (`https://github.com/o/r/pull/7`), or null. */
export function repoOfPrUrl(url: string): string | null {
  const at = url.lastIndexOf("/pull/");
  return at <= 0 || !/^\/pull\/\d+\/?$/.test(url.slice(at))
    ? null
    : repoOfRemoteUrl(url.slice(0, at));
}

/** The local branch, then the remote's; a branch already gone is fine. */
async function deleteBranches(
  deps: DropReleaseDeps,
  git: GitSession,
  claim: Pick<ClaimRecord, "branch">,
): Promise<DropReleaseOutcome> {
  const ref = `refs/heads/${claim.branch}`;
  const deleted = await git.step(git.repository, ["update-ref", "-d", ref]);
  if (deleted.code !== 0) {
    return {
      ok: false,
      why: `deleting the branch ${claim.branch} failed (${deleted.stderr.trim() || `exit ${deleted.code}`}); the worktree is gone`,
      files: [],
    };
  }
  // `branch -D` also drops the branch's configuration; `update-ref` does not.
  await git.step(git.repository, ["config", "--remove-section", `branch.${claim.branch}`]);
  const { remote } = deps.git.settings;
  if ((await remoteUrl(git, remote)) === null) return { ok: true, remoteProblem: null };
  const pushed = await git
    .step(git.repository, ["push", "--quiet", "--no-verify", remote, "--delete", claim.branch], {
      config: FETCH_CONFIG,
      timeoutMs: EXTERNAL_STEP_TIMEOUT_MS,
    })
    .catch((error: unknown): GitResult => {
      if (isTimedOut(error)) return { code: null, stdout: "", stderr: error.message };
      throw error;
    });
  if (pushed.code === 0 || remoteRefMissing(pushed.stderr)) {
    return { ok: true, remoteProblem: null };
  }
  return { ok: true, remoteProblem: pushed.stderr.trim() || `exit ${pushed.code}` };
}
