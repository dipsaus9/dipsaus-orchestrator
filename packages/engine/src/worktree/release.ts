// Releasing a claim for `story.drop` (DIPO-160; 0020 section 8, 0010 section 2a). A claim has no
// worktree, so a release is its row and, at most, its branch:
// - without `deleteBranch` the branch is kept and recorded as released for the story;
// - with `deleteBranch` the branch is deleted locally and on the remote, and nothing is recorded as
//   released. Clients ask for the typed story id first (`irreversibleWhen: ["deleteBranch"]`).
// The git steps are one item of the office git queue; the claim row is released after them, and
// every step is idempotent, so a re-run finishes what a crash left. The box goes with the claim
// (`box/lifetime.ts`).
//
// `work.discard` (DIPO-161) deletes the remote branch only when every commit on its tip is on the
// local branch or on the base (`deleteOwnBranch`), so no remote commit goes unlisted;
// `removeLeftovers` removes the branches a story Done elsewhere left behind.

import type { Clock, OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import { forgetContextPack } from "../context/pack";
import type { OfficeHandle } from "../db/office";
import { FETCH_CONFIG } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { EXTERNAL_STEP_TIMEOUT_MS, type GitResult, isTimedOut } from "../git/runner";
import { deleteBranch, deleteRemoteBranch, remoteUrl } from "../git/write";
import { repoOfRemoteUrl } from "../platform/host";
import { forgetWorkerNotes } from "../prompts/notes";

import { type ClaimRecord, markReclaimed, type ReleasedBranch, releaseClaim } from "./records";

/** The release reason of a claim `story.drop` released. */
export const DROP_RELEASE_REASON = "drop";

export interface DropReleaseDeps {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly clock: Clock;
}

export type DropReleaseOutcome =
  | {
      readonly ok: true;
      /** Why the remote branch may still exist after `deleteBranch`, or null. */
      readonly remoteProblem: string | null;
    }
  | { readonly ok: false; readonly why: string };

/** Releases the claim as `story.drop` does; see the file comment. */
export async function releaseForDrop(
  deps: DropReleaseDeps,
  claim: ClaimRecord,
  options: { readonly deleteBranch: boolean },
): Promise<DropReleaseOutcome> {
  const outcome = options.deleteBranch
    ? await deps.git.run((git) => deleteBranches(deps, git, claim))
    : ({ ok: true, remoteProblem: null } as const);
  if (!outcome.ok) return outcome;
  deps.office.immediate(() => {
    releaseClaim(deps.office, claim.runId, {
      at: deps.clock.now(),
      reason: DROP_RELEASE_REASON,
      ending: "dropped",
      keepBranch: !options.deleteBranch,
    });
    forgetWorkerNotes(deps.office, claim.branch);
    forgetContextPack(deps.office, claim.branch);
  });
  return outcome;
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
  | { readonly ok: false; readonly why: string };

/**
 * Releases the claim as `work.discard` does (0020 section 8): the branch is deleted locally and on
 * the remote when nothing there is missing from the local branch or the base (`deleteOwnBranch`;
 * the client listed what is lost and asked for the typed story id first); nothing is recorded as
 * released. The claim is released as `discard` and its tier T rows are forgotten. One queue item
 * for the git steps; every step is idempotent.
 */
export async function releaseForDiscard(
  deps: DropReleaseDeps,
  claim: ClaimRecord,
): Promise<DiscardBranchOutcome> {
  const outcome = await deps.git.run((git): Promise<DiscardBranchOutcome> =>
    deleteOwnBranch(deps, git, claim.branch, claim.base),
  );
  if (!outcome.ok) return outcome;
  deps.office.immediate(() => {
    releaseClaim(deps.office, claim.runId, {
      at: deps.clock.now(),
      reason: DISCARD_RELEASE_REASON,
      ending: "dropped",
      keepBranch: false,
    });
    forgetWorkerNotes(deps.office, claim.branch);
    forgetContextPack(deps.office, claim.branch);
  });
  return outcome;
}

/** What `work.discard` removes of the leftovers of a story Done elsewhere (0020 section 10). */
export interface LeftoverTargets {
  /** The runs whose leftovers these are; their rows are cleared once the branches are gone. */
  readonly runs: readonly RunId[];
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
 * 0020 section 10): each branch of `leftoverBranchNames` is deleted locally and, under
 * `deleteOwnBranch`'s rule, on the remote; each release row is marked reclaimed.
 */
export async function removeLeftovers(
  deps: DropReleaseDeps,
  targets: LeftoverTargets,
): Promise<DiscardBranchOutcome> {
  return deps.git.run(async (git): Promise<DiscardBranchOutcome> => {
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
    const deleted = await deleteBranch(git, branch, local);
    if (deleted.code !== 0) {
      return {
        ok: false,
        why: `deleting the branch ${branch} failed (${deleted.stderr.trim() || `exit ${deleted.code}`})`,
      };
    }
  }
  if (found.kind === "none") return { ok: true, remoteProblem: null, remoteKept: null };
  if (found.kind === "unread") return { ok: true, remoteProblem: found.problem, remoteKept: null };
  if (!found.covered) return { ok: true, remoteProblem: null, remoteKept: found.tip };
  const deleted = await deleteRemoteBranch(git, deps.git.settings.remote, branch, found.tip);
  return { ok: true, remoteProblem: deleted.ok ? null : deleted.problem, remoteKept: null };
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

/**
 * The remote branch, with a lease on the local tip (the tip dipo pushes), then the local branch at
 * that tip; a branch already gone is fine. Without a local branch dipo knows no tip it pushed, so
 * a remote branch is left and reported.
 */
async function deleteBranches(
  deps: DropReleaseDeps,
  git: GitSession,
  claim: Pick<ClaimRecord, "branch">,
): Promise<DropReleaseOutcome> {
  const local = await revParseCommit(git, `refs/heads/${claim.branch}`);
  const { remote } = deps.git.settings;
  let remoteProblem: string | null = null;
  if ((await remoteUrl(git, remote)) !== null) {
    if (local === null) {
      const listed = await external(git, ["ls-remote", remote, `refs/heads/${claim.branch}`]);
      if (listed.code !== 0 || listed.stdout.trim() !== "") {
        remoteProblem = `dipo knows no tip it pushed for ${claim.branch}, so it does not delete the remote branch`;
      }
    } else {
      const deleted = await deleteRemoteBranch(git, remote, claim.branch, local);
      remoteProblem = deleted.ok ? null : deleted.problem;
    }
  }
  if (local !== null) {
    const deleted = await deleteBranch(git, claim.branch, local);
    if (deleted.code !== 0) {
      return {
        ok: false,
        why: `deleting the branch ${claim.branch} failed (${deleted.stderr.trim() || `exit ${deleted.code}`})`,
      };
    }
  }
  return { ok: true, remoteProblem };
}
