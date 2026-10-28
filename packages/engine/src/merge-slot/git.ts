// The git steps of the merge slot for a backlog PR (0016 rule 2, 0010 section 7 Merge slot row).
// Each method is its own item of the office git queue, so claims and commits of other stories run
// between the steps, and waiting for CI never holds the queue. The steps run in the engine's
// backlog worktree `<root>/_backlog`, where the lane keeps its branch.

import type { OfficeLane } from "../backlog/lane/lane";
import { BASE_CHECKOUT_CONFIG, BASE_CHECKOUT_ENV } from "../git/hardened";
import type { GitSession } from "../git/office";
import { EXTERNAL_STEP_TIMEOUT_MS, GitError, type GitStepOptions, isTimedOut } from "../git/runner";
import {
  abortMerge,
  deleteBranch,
  deleteRemoteBranch,
  mergeInWorktree,
  pushRef,
  resetWorktree,
} from "../git/write";

const CHECKOUT: GitStepOptions = { config: BASE_CHECKOUT_CONFIG, env: BASE_CHECKOUT_ENV };

/** What step 2 did: the branch already held the base, took a merge commit, or conflicts. */
export type BaseSync =
  | { readonly kind: "contained"; readonly head: string }
  | { readonly kind: "merged"; readonly head: string }
  | { readonly kind: "conflict" };

export type PushOutcome =
  | { readonly ok: true; readonly pushed: boolean }
  | { readonly ok: false; readonly detail: string };

/** The git the merge slot needs; `laneSlotGit` is the real one, tests use fakes. */
export interface SlotGit {
  /** Fetches the remote; false when the fetch failed (the fetch records why). */
  fetch(): Promise<boolean>;
  /** The local tip of `branch`, or null when it does not exist. */
  head(branch: string): Promise<string | null>;
  /** True when `branch` contains `<remote>/<base>`. */
  containsBase(branch: string): Promise<boolean>;
  /**
   * Merges `<remote>/<base>` into `branch` (never a rebase), unless the branch contains it. A
   * merge that conflicts is aborted and reported as `conflict`; the branch stays as it was.
   */
  syncBase(branch: string): Promise<BaseSync>;
  /** Pushes `branch` once, never forced, when its tip differs from the remote's. */
  push(branch: string): Promise<PushOutcome>;
  /** True when `commit` is `head` or one of its ancestors; false when either is unknown. */
  inHead(commit: string, head: string): Promise<boolean>;
  /**
   * Deletes the merged `branch` locally and, best effort, on the remote. Returns why the remote
   * branch may still exist, or null when it is gone.
   */
  deleteBranch(branch: string): Promise<string | null>;
}

async function revParse(git: GitSession, ref: string): Promise<string | null> {
  const result = await git.step(git.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** True when `branch` contains `base`. */
async function contains(git: GitSession, base: string, branch: string): Promise<boolean> {
  const result = await git.step(git.repository, [
    "merge-base",
    "--is-ancestor",
    base,
    `refs/heads/${branch}`,
  ]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new GitError(
    "git.failed",
    `git merge-base --is-ancestor failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    false,
    { code: result.code },
  );
}

/** The slot's git steps on the lane's office git and its backlog worktree. */
export function laneSlotGit(lane: OfficeLane): SlotGit {
  const officeGit = lane.git;
  const remote = () => officeGit.settings.remote;
  const baseRef = async () => `refs/remotes/${remote()}/${await officeGit.resolveBase()}`;
  const worktree = () => {
    const location = officeGit.worktreeLocation(lane.worktreePath());
    if (location.kind !== "worktree") throw new Error("expected the backlog worktree");
    return location;
  };
  return {
    fetch: async () => (await officeGit.fetch()).ok,

    head: (branch) => officeGit.run((git) => revParse(git, `refs/heads/${branch}`)),

    inHead: (commit, head) =>
      officeGit.run(async (git) => {
        const result = await git.step(git.repository, [
          "merge-base",
          "--is-ancestor",
          commit,
          head,
        ]);
        return result.code === 0;
      }),

    containsBase: async (branch) => {
      const base = await baseRef();
      return officeGit.run((git) => contains(git, base, branch));
    },

    syncBase: async (branch) => {
      const base = await baseRef();
      return officeGit.run(async (git): Promise<BaseSync> => {
        const before = await revParse(git, `refs/heads/${branch}`);
        if (before === null) throw new Error(`The backlog branch ${branch} no longer exists.`);
        if (await contains(git, base, branch)) return { kind: "contained", head: before };
        const location = worktree();
        await git.ok(
          location,
          ["checkout", "--quiet", "--force", "--no-recurse-submodules", branch],
          CHECKOUT,
        );
        await git.ok(location, ["clean", "-fdq"]);
        const message = `Merge ${base.slice("refs/remotes/".length)} into ${branch}`;
        let result;
        try {
          result = await mergeInWorktree(git, location, { commit: base, message }, CHECKOUT);
        } catch (error) {
          // A merge commit waiting on a signing prompt was killed: leave the branch as it was.
          await abortMerge(git, location);
          if (isTimedOut(error)) {
            throw new Error(`the merge commit on ${branch} timed out: ${error.message}`, {
              cause: error,
            });
          }
          throw error;
        }
        if (result.code === 0) {
          const head = await revParse(git, `refs/heads/${branch}`);
          if (head === null)
            throw new Error(`The backlog branch ${branch} vanished after a merge.`);
          return { kind: "merged", head };
        }
        const unmerged = await git.ok(location, ["ls-files", "--unmerged"]);
        await abortMerge(git, location);
        await resetWorktree(git, location, before, CHECKOUT);
        await git.ok(location, ["clean", "-fdq"]);
        if (unmerged.trim() !== "") return { kind: "conflict" };
        throw new GitError(
          "git.failed",
          `git merge of ${base} into ${branch} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
          false,
          { code: result.code },
        );
      });
    },

    push: (branch) =>
      officeGit.run(async (git): Promise<PushOutcome> => {
        const local = await revParse(git, `refs/heads/${branch}`);
        const tracking = await revParse(git, `refs/remotes/${remote()}/${branch}`);
        if (local === null) return { ok: false, detail: `the branch ${branch} does not exist` };
        if (local === tracking) return { ok: true, pushed: false };
        const result = await pushRef(git, remote(), branch);
        if (result.code === null) {
          return {
            ok: false,
            detail: `pushing to ${remote()} was killed after ${EXTERNAL_STEP_TIMEOUT_MS / 1000} s; the remote may be waiting for credentials`,
          };
        }
        if (result.code !== 0) {
          return {
            ok: false,
            detail: `pushing to ${remote()} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
          };
        }
        return { ok: true, pushed: true };
      }),

    deleteBranch: (branch) =>
      officeGit.run(async (git): Promise<string | null> => {
        // `_backlog` may have the branch checked out; detach it where it is first.
        const location = officeGit.worktreeLocation(lane.worktreePath());
        if (location.kind === "worktree") {
          await git.step(location, ["checkout", "--quiet", "--detach"], CHECKOUT);
        }
        // The remote branch goes with a lease on the tip dipo pushed, the local tip the slot pushed
        // and the host merged; without a local branch dipo knows no such tip and keeps it.
        const tip = await revParse(git, `refs/heads/${branch}`);
        if (tip === null) {
          return `the local branch ${branch} is gone, so dipo knows no tip it pushed and does not delete the remote branch`;
        }
        const local = await deleteBranch(git, branch, tip);
        // The host may have deleted it already; a missing remote branch is fine.
        const remoteDelete = await deleteRemoteBranch(git, remote(), branch, tip);
        const problems = [
          local.code === 0 ? null : `deleting the local branch failed (${local.stderr.trim()})`,
          remoteDelete.ok ? null : `deleting the remote branch failed (${remoteDelete.problem})`,
        ].filter((problem) => problem !== null);
        return problems.length === 0 ? null : problems.join("; ");
      }),
  };
}
