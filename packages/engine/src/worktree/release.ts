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

import { existsSync } from "node:fs";

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import { forgetContextPack } from "../context/pack";
import type { OfficeHandle } from "../db/office";
import { FETCH_CONFIG } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { EXTERNAL_STEP_TIMEOUT_MS, type GitResult, isTimedOut } from "../git/runner";
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
  claim: ClaimRecord,
): Promise<string[]> {
  return deps.git.run(async (git) => {
    if (deps.git.adminDirOf(claim.worktree) === null) return [];
    return dirtyFiles(deps, git, claim.worktree);
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
  claim: ClaimRecord,
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
