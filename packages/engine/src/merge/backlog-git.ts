// The git the auto-merge of a backlog PR needs (0010 planning lane, 0002): the local tip of the
// lane's branch, whether a journaled commit is in the head GitHub merged, and the merged branch's
// deletion. Each method is its own item of the office git queue, in the engine's backlog worktree
// `<root>/_backlog`, where the lane keeps its branch.

import type { OfficeLane } from "../backlog/lane/lane";
import { BASE_CHECKOUT_CONFIG, BASE_CHECKOUT_ENV } from "../git/hardened";
import type { GitSession } from "../git/office";
import type { GitStepOptions } from "../git/runner";
import { deleteBranch, deleteRemoteBranch } from "../git/write";

const CHECKOUT: GitStepOptions = { config: BASE_CHECKOUT_CONFIG, env: BASE_CHECKOUT_ENV };

/** The git a backlog PR's auto-merge needs; `laneMergeGit` is the real one, tests use fakes. */
export interface BacklogMergeGit {
  /** The local tip of `branch`, or null when it does not exist. */
  head(branch: string): Promise<string | null>;
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

/** The backlog auto-merge's git on the lane's office git and its backlog worktree. */
export function laneMergeGit(lane: OfficeLane): BacklogMergeGit {
  const officeGit = lane.git;
  return {
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

    deleteBranch: (branch) =>
      officeGit.run(async (git): Promise<string | null> => {
        // `_backlog` may have the branch checked out; detach it where it is first.
        const location = officeGit.worktreeLocation(lane.worktreePath());
        if (location.kind === "worktree") {
          await git.step(location, ["checkout", "--quiet", "--detach"], CHECKOUT);
        }
        // The remote branch goes with a lease on the tip dipo pushed, the local tip GitHub merged;
        // without a local branch dipo knows no such tip and keeps it.
        const tip = await revParse(git, `refs/heads/${branch}`);
        if (tip === null) {
          return `the local branch ${branch} is gone, so dipo knows no tip it pushed and does not delete the remote branch`;
        }
        const local = await deleteBranch(git, branch, tip);
        // The host may have deleted it already; a missing remote branch is fine.
        const remote = await deleteRemoteBranch(git, officeGit.settings.remote, branch, tip);
        const problems = [
          local.code === 0 ? null : `deleting the local branch failed (${local.stderr.trim()})`,
          remote.ok ? null : `deleting the remote branch failed (${remote.problem})`,
        ].filter((problem) => problem !== null);
        return problems.length === 0 ? null : problems.join("; ");
      }),
  };
}
