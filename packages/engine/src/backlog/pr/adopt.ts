// Reading an open backlog PR's branch for adoption after a lost database (DIPO-80; 0007 section 6,
// 0010 section 2). The lane can take a branch over only when every commit on it beyond the base is
// a lane commit (`backlog: <kind> <subject>` with one `Dipo-Op` trailer), when the local branch and
// the PR's head do not diverge, and when the branch still merges into the base: the target states
// of its operations were journaled in the lost database, so the lane could not rebuild it. Merge
// commits (the merge slot's base syncs) are allowed. Everything here runs inside one item of the
// office git queue and only reads, except `placeBranch`.

import type { GitSession } from "../../git/office";
import { GitError } from "../../git/runner";
import { OP_TRAILER } from "../lane/lane";

/** A lane commit on the branch, oldest first. */
export interface BranchOp {
  readonly opId: number;
  readonly kind: string;
  readonly subject: string;
  readonly commit: string;
  /** True when the commit is in the PR's head on the host (pushed), false when only local. */
  readonly pushed: boolean;
}

/** A branch the lane can take over. */
export interface AdoptableBranch {
  readonly ok: true;
  readonly tip: string;
  readonly ops: readonly BranchOp[];
  /** The local branch to create (`null`) or move (its current tip) to `tip`; undefined to keep. */
  readonly local: { readonly from: string | null } | undefined;
}

export type BranchReading = AdoptableBranch | { readonly ok: false; readonly reason: string };

export interface BranchToRead {
  readonly branch: string;
  /** The PR's head commit as the host reports it; empty when unknown. */
  readonly hostHead: string;
  /** The base the PR targets on the host. */
  readonly prBase: string;
  readonly remote: string;
  /** The office's base branch name. */
  readonly base: string;
}

/** `backlog: <kind> <subject>`, as the lane commits (`messageOf` in lane.ts). */
const LANE_SUBJECT = /^backlog: (\S+) (.+)$/;

async function revParse(git: GitSession, ref: string): Promise<string | null> {
  const result = await git.step(git.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function isAncestor(git: GitSession, ancestor: string, of: string): Promise<boolean> {
  const result = await git.step(git.repository, ["merge-base", "--is-ancestor", ancestor, of]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new GitError(
    "git.failed",
    `git merge-base --is-ancestor failed: ${result.stderr.trim() || `exit ${result.code}`}`,
    false,
    { code: result.code },
  );
}

const short = (sha: string) => sha.slice(0, 12);

const refuse = (reason: string): BranchReading => ({ ok: false, reason });

/** Reads `branch` and says whether the lane can take it over, and if not, why. */
export async function readBranch(git: GitSession, pr: BranchToRead): Promise<BranchReading> {
  if (pr.prBase !== pr.base) {
    return refuse(`it targets ${pr.prBase}, not the office's base ${pr.base}`);
  }
  const baseRef = `refs/remotes/${pr.remote}/${pr.base}`;
  const base = await revParse(git, baseRef);
  if (base === null) return refuse(`${baseRef} does not exist here`);
  const tracking = await revParse(git, `refs/remotes/${pr.remote}/${pr.branch}`);
  const head =
    pr.hostHead === ""
      ? tracking
      : (await revParse(git, pr.hostHead)) === null
        ? null
        : pr.hostHead;
  if (head === null) {
    return refuse(
      `its head ${pr.hostHead === "" ? "" : `${short(pr.hostHead)} `}is not in the local repository (fetch ${pr.remote} and rescan the office)`,
    );
  }

  const localTip = await revParse(git, `refs/heads/${pr.branch}`);
  let tip = head;
  let local: AdoptableBranch["local"];
  if (localTip === null) {
    local = { from: null };
  } else if (localTip === head) {
    local = undefined;
  } else if (await isAncestor(git, head, localTip)) {
    // The local branch has commits the push never delivered: they are the lane's too.
    tip = localTip;
    local = undefined;
  } else if (await isAncestor(git, localTip, head)) {
    local = { from: localTip };
  } else {
    return refuse(
      `the local branch ${pr.branch} (${short(localTip)}) and the PR's head (${short(head)}) have diverged`,
    );
  }

  const merge = await git.step(git.repository, ["merge-tree", "--write-tree", base, tip]);
  if (merge.code === 1) {
    return refuse(
      `it no longer merges into ${pr.base}, and dipo cannot rebuild it: its operations were journaled in the lost database`,
    );
  }
  if (merge.code !== 0) {
    throw new GitError(
      "git.failed",
      `git merge-tree --write-tree failed: ${merge.stderr.trim() || `exit ${merge.code}`}`,
      false,
      { code: merge.code },
    );
  }

  const log = await git.ok(git.repository, [
    "log",
    "--no-merges",
    "--reverse",
    `--format=%H%x1f%s%x1f%(trailers:key=${OP_TRAILER},valueonly,separator=%x2c)%x1e`,
    tip,
    `^${base}`,
  ]);
  const ops: BranchOp[] = [];
  const seen = new Set<number>();
  for (const record of log.split("\x1e")) {
    const [sha, subject, trailer] = record.trim().split("\x1f");
    if (sha === undefined || sha === "") continue;
    const match = LANE_SUBJECT.exec(subject ?? "");
    const ids = (trailer ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    const opId = ids.length === 1 ? Number(ids[0]) : NaN;
    if (
      match?.[1] === undefined ||
      match[2] === undefined ||
      !Number.isInteger(opId) ||
      opId <= 0
    ) {
      return refuse(
        `its commit ${short(sha)} (${JSON.stringify(subject ?? "")}) is not a dipo backlog commit with one ${OP_TRAILER} trailer`,
      );
    }
    if (seen.has(opId)) {
      return refuse(`two of its commits name the same operation ${OP_TRAILER}: ${opId}`);
    }
    seen.add(opId);
    ops.push({
      opId,
      kind: match[1],
      subject: match[2],
      commit: sha,
      pushed: await isAncestor(git, sha, head),
    });
  }
  if (ops.length === 0) return refuse(`it has no backlog commits that are not on ${pr.base}`);
  return { ok: true, tip, ops, local };
}

/** Creates the local branch at `tip`, or moves it there from its old tip, never anywhere else. */
export async function placeBranch(
  git: GitSession,
  branch: string,
  tip: string,
  local: AdoptableBranch["local"],
): Promise<void> {
  if (local === undefined) return;
  if (local.from === null) {
    await git.ok(git.repository, ["branch", "--no-track", branch, tip]);
    return;
  }
  await git.ok(git.repository, ["update-ref", `refs/heads/${branch}`, tip, local.from]);
}
