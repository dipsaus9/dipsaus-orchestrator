// The one git writer (0010): every commit, ref change, push and branch delete dipo makes on the
// maintainer's repository goes through these functions, inside an office git queue item the
// caller holds, as hardened steps of `GitSession` (`hardened.ts`, `runner.ts`). No other engine
// file passes a git verb that writes a commit or a ref, or reaches the remote to change it; the
// lint rules `dipo/no-git-spawn` and `dipo/no-git-write` hold that line
// (`tools/lint/oxlint-plugin.js`).
//
// - Commits: `commitTree` from git objects (the story lane, parts, catch-up merges) and
//   `commitStaged` in the planning lane's own worktree.
// - Refs: a branch is created only where none exists (`createBranch`, `update-ref` with an empty
//   old value, so a lost race is a `false`, never an overwrite), moved only from the tip the caller
//   read (`moveRef`), and deleted only at the tip the caller read (`deleteBranch`).
// - Remote: a push is never forced and never targets the office's base (`pushRef`), and a remote
//   branch delete carries a lease on the tip dipo pushed (`deleteRemoteBranch`), so a push that
//   landed since is never deleted; the base is never deleted either.
// - Worktrees: a story worktree an earlier binary left is removed only without `--force`
//   (`removeLeftoverWorktree`), so git itself refuses one with changes.

import type { GitLocation } from "./hardened";
import { FETCH_CONFIG } from "./hardened";
import type { GitSession } from "./office";
import {
  EXTERNAL_STEP_TIMEOUT_MS,
  GitError,
  type GitResult,
  type GitStepOptions,
  isTimedOut,
} from "./runner";

/** A step that reaches the remote: the fetch config and the external deadline; a timeout is a result. */
function remoteStep(git: GitSession, args: readonly string[]): Promise<GitResult> {
  return git
    .step(git.repository, args, { config: FETCH_CONFIG, timeoutMs: EXTERNAL_STEP_TIMEOUT_MS })
    .catch((error: unknown): GitResult => {
      // A push waiting on a credential prompt was killed: a failed push like any other.
      if (isTimedOut(error)) return { code: null, stdout: "", stderr: error.message };
      throw error;
    });
}

const branchRef = (branch: string): string => `refs/heads/${branch}`;

// ---- commits -------------------------------------------------------------------------------------

/** A commit message: the subject, then an optional body paragraph each. */
export interface CommitMessage {
  readonly subject: string;
  readonly body?: readonly string[];
}

/**
 * Commits `tree` with `parents` from git objects (`git commit-tree`) and returns the commit. No
 * ref moves; the caller moves its branch with `moveRef`. Signing follows the maintainer's own
 * configuration, so the step has the external deadline.
 */
export async function commitTree(
  git: GitSession,
  location: GitLocation,
  input: {
    readonly tree: string;
    readonly parents: readonly string[];
    readonly message: CommitMessage;
  },
): Promise<string> {
  const { message } = input;
  const out = await git.ok(
    location,
    [
      "commit-tree",
      input.tree,
      ...input.parents.flatMap((parent) => ["-p", parent]),
      ...[message.subject, ...(message.body ?? [])].flatMap((part) => ["-m", part]),
    ],
    { timeoutMs: EXTERNAL_STEP_TIMEOUT_MS },
  );
  return out.trim();
}

/**
 * Commits what is staged in a worktree dipo owns (`git commit --no-verify`, hooks off as every
 * hardened call), with the external deadline. Returns git's result, so the caller judges a failure; a timeout
 * throws `git.timedOut`.
 */
export function commitStaged(
  git: GitSession,
  location: GitLocation,
  message: CommitMessage,
): Promise<GitResult> {
  return git.step(
    location,
    [
      "commit",
      "--quiet",
      "--no-verify",
      ...[message.subject, ...(message.body ?? [])].flatMap((p) => ["-m", p]),
    ],
    { timeoutMs: EXTERNAL_STEP_TIMEOUT_MS },
  );
}

/**
 * Resets a worktree dipo owns to `to` (`git reset --hard`): its checked-out branch, if any, moves
 * there, and its files follow.
 */
export async function resetWorktree(
  git: GitSession,
  location: GitLocation,
  to: string,
  options: GitStepOptions = {},
): Promise<void> {
  await git.ok(location, ["reset", "--hard", "--quiet", to], options);
}

// ---- worktrees -----------------------------------------------------------------------------------

/**
 * Removes the worktree at `path` that an earlier binary made for a story (0010: a story has no
 * worktree any more): its lock `lock` is lifted, then `git worktree remove` runs without `--force`,
 * so git refuses a worktree with changes or untracked files. A refusal locks it again with the same
 * reason and returns git's result; the branch it had checked out is never touched.
 */
export async function removeLeftoverWorktree(
  git: GitSession,
  path: string,
  lock: string | null,
): Promise<GitResult> {
  if (lock !== null) await git.ok(git.repository, ["worktree", "unlock", path]);
  const removed = await git.step(git.repository, ["worktree", "remove", path]);
  if (removed.code !== 0 && lock !== null) {
    await git.step(git.repository, ["worktree", "lock", "--reason", lock, path]);
  }
  return removed;
}

// ---- refs ----------------------------------------------------------------------------------------

/**
 * Creates `refs/heads/<branch>` at `start` only when no such ref exists: `git update-ref` with an
 * empty old value, atomic in git. Returns false when the ref exists (another claim or process won
 * the race); nothing is overwritten. Any other failure throws `git.failed`.
 */
export async function createBranch(
  git: GitSession,
  branch: string,
  start: string,
  reason = `dipo: create ${branch}`,
): Promise<boolean> {
  const ref = branchRef(branch);
  const result = await git.step(git.repository, ["update-ref", "-m", reason, ref, start, ""]);
  if (result.code === 0) return true;
  const exists = await git.step(git.repository, ["rev-parse", "--verify", "--quiet", ref]);
  if (exists.code === 0) return false;
  throw new GitError(
    "git.failed",
    `git update-ref ${ref} ${start} "" failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    false,
    { ref, code: result.code, stderr: result.stderr },
  );
}

/**
 * Moves `ref` (a full ref name, or `HEAD` of a worktree) from `from` to `to` (`git update-ref` with
 * the old value). Returns false when the ref is no longer at `from`; it then stays where it is.
 */
export async function moveRef(
  git: GitSession,
  location: GitLocation,
  input: {
    readonly ref: string;
    readonly to: string;
    readonly from: string;
    readonly reason?: string;
  },
): Promise<boolean> {
  const result = await git.step(location, [
    "update-ref",
    ...(input.reason === undefined ? [] : ["-m", input.reason]),
    input.ref,
    input.to,
    input.from,
  ]);
  return result.code === 0;
}

/** `moveRef` on `refs/heads/<branch>`, on the repository. */
export function moveBranch(
  git: GitSession,
  branch: string,
  to: string,
  from: string,
  reason?: string,
): Promise<boolean> {
  return moveRef(git, git.repository, {
    ref: branchRef(branch),
    to,
    from,
    ...(reason === undefined ? {} : { reason }),
  });
}

/**
 * Deletes the local `branch` only while it is at `tip` (`git update-ref -d <ref> <tip>`, the forced
 * delete of `branch -D` without its race), then its configuration, as `branch -D` would. Returns
 * git's result of the delete; a failed delete leaves the configuration.
 */
export async function deleteBranch(
  git: GitSession,
  branch: string,
  tip: string,
): Promise<GitResult> {
  const deleted = await git.step(git.repository, ["update-ref", "-d", branchRef(branch), tip]);
  // A branch without configuration is fine (exit 5 or 128, "no such section").
  if (deleted.code === 0) {
    await git.step(git.repository, ["config", "--remove-section", `branch.${branch}`]);
  }
  return deleted;
}

// ---- the remote ----------------------------------------------------------------------------------

/** What the push of a branch did. */
export interface PushResult {
  readonly pushed: boolean;
  /** True when the remote refused a non-fast-forward update (0010: park `conflict`). */
  readonly rejected: boolean;
  /** Why the push failed, or null; null with `pushed` false means the office has no remote. */
  readonly error: string | null;
}

/** The URL of `remote`, or null when the office has no such remote. */
export async function remoteUrl(git: GitSession, remote: string): Promise<string | null> {
  const result = await git.step(git.repository, ["config", "--get", `remote.${remote}.url`]);
  const url = result.stdout.trim();
  return result.code === 0 && url !== "" ? url : null;
}

/**
 * Pushes `refs/heads/<branch>` to the same ref on `remote`, never forced and without hooks, and
 * returns git's result; a push killed at its deadline is a result with `code` null.
 */
export async function pushRef(git: GitSession, remote: string, branch: string): Promise<GitResult> {
  const refused = await baseRefusal(git, branch, "pushes to");
  if (refused !== null) return { code: 1, stdout: "", stderr: refused };
  const ref = branchRef(branch);
  return remoteStep(git, ["push", "--quiet", "--no-verify", remote, `${ref}:${ref}`]);
}

/**
 * Why dipo refuses to change `branch` on the remote, or null: never the office's base (0010), and
 * nothing while the base is unknown, since then no branch can be told apart from it.
 */
async function baseRefusal(git: GitSession, branch: string, what: string): Promise<string | null> {
  let base: string;
  try {
    base = await git.base();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return `dipo never ${what} a remote branch while the office's base is unknown: ${why}`;
  }
  return branch === base ? `dipo never ${what} the base branch ${base}` : null;
}

/**
 * Pushes `branch` to `remote` (`pushRef`). Without a configured remote nothing is pushed and
 * `error` is null; a failed or timed-out push is returned, never thrown.
 */
export async function pushBranch(
  git: GitSession,
  remote: string,
  branch: string,
): Promise<PushResult> {
  if ((await remoteUrl(git, remote)) === null) {
    return { pushed: false, rejected: false, error: null };
  }
  const pushed = await pushRef(git, remote, branch);
  if (pushed.code === 0) return { pushed: true, rejected: false, error: null };
  const stderr = pushed.stderr.trim();
  return {
    pushed: false,
    rejected: /non-fast-forward|\[rejected\]|fetch first/.test(stderr),
    error: `pushing ${branch} to ${remote} failed (${stderr || `exit ${pushed.code}`})`,
  };
}

/** True when a remote delete failed because the remote has no such branch. */
export function remoteRefMissing(stderr: string): boolean {
  return stderr.includes("remote ref does not exist");
}

/** What a remote branch delete did. */
export type RemoteDelete =
  /** Deleted, or the remote no longer has the branch. */
  | { readonly ok: true }
  /** Not deleted: the remote tip moved from the lease, the remote refused, or it timed out. */
  | { readonly ok: false; readonly problem: string };

/**
 * Deletes `branch` on `remote` with a lease on `pushed`, the tip dipo pushed
 * (`--force-with-lease=refs/heads/<branch>:<pushed>`): when the remote tip is anything else, git
 * refuses and the branch stays. A branch the remote no longer has counts as deleted.
 */
export async function deleteRemoteBranch(
  git: GitSession,
  remote: string,
  branch: string,
  pushed: string,
): Promise<RemoteDelete> {
  const refused = await baseRefusal(git, branch, "deletes");
  if (refused !== null) return { ok: false, problem: refused };
  const result = await remoteStep(git, [
    "push",
    "--quiet",
    "--no-verify",
    `--force-with-lease=${branchRef(branch)}:${pushed}`,
    remote,
    "--delete",
    branch,
  ]);
  if (result.code === 0 || remoteRefMissing(result.stderr)) return { ok: true };
  return { ok: false, problem: result.stderr.trim() || `exit ${result.code}` };
}

// ---- reads the writers share ---------------------------------------------------------------------

/** Paths in `git status --porcelain=v1 -z` output, both sides of a rename or copy. */
export function statusPaths(output: string): string[] {
  const records = output.split("\0").filter((record) => record !== "");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    paths.push(record.slice(3));
    const x = record[0];
    if (x === "R" || x === "C") {
      i += 1;
      const from = records[i];
      if (from !== undefined) paths.push(from);
    }
  }
  return paths;
}
