// Done detection and teardown of a claimed story (DIPO-58; 0010 section 7, "Merge and Done",
// "Teardown" and the dirty-worktree failure case, open question 8; 0007 section 7, tier T).
//
// Done is detected in one of two ways, never by ancestry:
// - the host reports a merged PR whose head is the story branch, into the claim's base, and whose
//   head commit is the local branch tip (or the local branch is already gone);
// - `git merge-tree --write-tree origin/<base> <branch>` exits 0 and prints the tree of
//   `origin/<base>`: the branch adds nothing new. A branch still at the commit it started from has
//   nothing of its own and is never Done this way.
//
// Teardown runs as one item of the office git queue: unlock the worktree (only a lock this claim
// holds, `dipo <run-id>`), `git worktree remove <path>` without `--force`, then `git branch -D` and
// `git push <remote> --delete <branch>`, a branch the remote no longer has being fine. A worktree
// git refuses to remove (dirty) or one locked by anyone else keeps everything: the lock is put back,
// the claim stays live, and the caller gets the files `git status` lists for its notice. Only after
// the git steps the claim is released (`done`), the worktree's `worker_notes` and `context_packs`
// are deleted and its port slot freed. Every step is idempotent, so the next poll finishes a
// teardown a crash interrupted.

import { existsSync } from "node:fs";

import type { Clock, OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import { statusPaths } from "../backlog/lane/lane";
import { forgetContextPack } from "../context/pack";
import type { OfficeHandle } from "../db/office";
import { FETCH_CONFIG } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { canonicalFuturePath } from "../git/paths";
import { EXTERNAL_STEP_TIMEOUT_MS, type GitResult, isTimedOut } from "../git/runner";
import { CodeHostError, type PrStateHost, repoOfRemoteUrl } from "../platform/host";
import { forgetWorkerNotes } from "../prompts/notes";

import { notice, writeWith } from "./claim";
import { type ClaimRecord, releaseClaim } from "./records";
import type { SlotTable } from "./slots";

/** `engine.notice` codes of Done detection and teardown. */
export const TEARDOWN_NOTICES = {
  done: "teardown.done",
  kept: "teardown.kept",
  parked: "teardown.parked",
  remoteBranch: "teardown.remoteBranch",
  checkFailed: "done.checkFailed",
  unmergedCommits: "done.unmergedCommits",
} as const;

/** The release reason of a claim whose story reached Done. */
export const DONE_RELEASE_REASON = "done";

/** How Done was detected. */
export type DoneEvidence =
  | { readonly by: "host"; readonly number: number; readonly url: string }
  | { readonly by: "merge-tree"; readonly tree: string };

/** A problem the detection reports as a notice; the story stays where it is. */
export interface DoneProblem {
  readonly code: string;
  readonly text: string;
}

export type DoneCheck =
  | { readonly done: true; readonly evidence: DoneEvidence }
  | { readonly done: false; readonly problem?: DoneProblem };

export interface DetectDeps {
  readonly git: OfficeGit;
  /** The code host; null where the office has none, so only `merge-tree` decides. */
  readonly host: PrStateHost | null;
}

/** What the detection reads from git in one queue item. */
interface BranchFacts {
  /** The remote's URL, or null without a remote. */
  readonly url: string | null;
  /** `refs/remotes/<remote>/<base>`, or `refs/heads/<base>` without a remote. */
  readonly baseRef: string;
  /** The local branch tip, or null when the branch is gone. */
  readonly tip: string | null;
}

/** Detects whether the claimed story is Done; see the file comment for the two ways. */
export async function detectDone(deps: DetectDeps, claim: ClaimRecord): Promise<DoneCheck> {
  const { remote } = deps.git.settings;
  const facts = await deps.git.run(async (git): Promise<BranchFacts> => {
    const url = await remoteUrl(git, remote);
    return {
      url,
      baseRef: url === null ? `refs/heads/${claim.base}` : `refs/remotes/${remote}/${claim.base}`,
      tip: await revParse(git, `refs/heads/${claim.branch}`),
    };
  });

  let mergedElsewhere: number | null = null;
  const repo = facts.url === null ? null : repoOfRemoteUrl(facts.url);
  if (deps.host !== null && repo !== null) {
    try {
      const pr = await deps.host.findMergedPr(repo, claim.branch);
      if (pr !== null && pr.base === claim.base) {
        if (facts.tip === null || pr.headSha === facts.tip) {
          return { done: true, evidence: { by: "host", number: pr.number, url: pr.url } };
        }
        mergedElsewhere = pr.number;
      }
    } catch (error) {
      // The host is unreachable or gh is unusable: merge-tree still decides, the next poll asks again.
      if (!(error instanceof CodeHostError)) throw error;
    }
  }

  const tree = await deps.git.run((git) => mergeTreeDone(git, facts, claim));
  if (tree.done || tree.problem !== undefined || mergedElsewhere === null) return tree;
  return {
    done: false,
    problem: {
      code: TEARDOWN_NOTICES.unmergedCommits,
      text: `The PR #${mergedElsewhere} of ${claim.story} merged, but the local branch ${claim.branch} is at ${facts.tip ?? "(gone)"}, not at the head that merged, and holds changes the base does not have. dipo keeps the worktree and branch; check them by hand.`,
    },
  };
}

/** The `merge-tree` rule (0010 section 7 "Conflict check" and "Merge and Done"). */
async function mergeTreeDone(
  git: GitSession,
  facts: BranchFacts,
  claim: ClaimRecord,
): Promise<DoneCheck> {
  if (facts.tip === null || facts.tip === claim.startSha) return { done: false };
  const failed = (detail: string): DoneCheck => ({
    done: false,
    problem: {
      code: TEARDOWN_NOTICES.checkFailed,
      text: `dipo could not check whether ${claim.story} is merged: ${detail}. The story stays where it is.`,
    },
  });
  const baseTree = await revParse(git, `${facts.baseRef}^{tree}`, "tree");
  if (baseTree === null) return failed(`${facts.baseRef} does not exist`);
  const result = await git.step(git.repository, [
    "merge-tree",
    "--write-tree",
    facts.baseRef,
    `refs/heads/${claim.branch}`,
  ]);
  if (result.code === 1) return { done: false };
  if (result.code !== 0) {
    return failed(
      `\`git merge-tree --write-tree\` failed (${result.stderr.trim() || `exit ${result.code}`})`,
    );
  }
  return firstLine(result.stdout) === baseTree
    ? { done: true, evidence: { by: "merge-tree", tree: baseTree } }
    : { done: false };
}

// ---- teardown --------------------------------------------------------------------------------

export interface TeardownDeps {
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly clock: Clock;
  /** The machine-wide port slot table; the worktree's slot is freed there. */
  readonly slots?: SlotTable;
  readonly onChanged?: (office: OfficeId) => void;
}

export type TeardownOutcome =
  | {
      readonly ok: true;
      /** Why the remote branch may still exist, or null when it is gone. */
      readonly remoteProblem: string | null;
    }
  | {
      readonly ok: false;
      /** Why everything was kept. */
      readonly why: string;
      /** The files `git status` lists in the worktree (empty when it could not be read). */
      readonly files: readonly string[];
    };

/** The lock reason of a worktree the claim of `runId` holds. */
export function claimLockReason(runId: RunId): string {
  return `dipo ${runId}`;
}

/**
 * Tears down the worktree and branch of a claim whose story is Done, then releases the claim,
 * deletes its tier T rows and frees its slot. A dirty or foreign-locked worktree keeps everything.
 * The caller puts the notices on the office.
 */
export async function tearDown(
  deps: TeardownDeps,
  claim: ClaimRecord,
  evidence: DoneEvidence,
): Promise<TeardownOutcome> {
  const outcome = await deps.git.run((git) => removeAll(deps, git, claim));
  if (!outcome.ok) return outcome;
  const how =
    evidence.by === "host"
      ? `its PR #${evidence.number} merged (${evidence.url})`
      : "its branch adds nothing to the base";
  writeWith(deps, () => {
    releaseClaim(deps.office, claim.runId, {
      at: deps.clock.now(),
      reason: DONE_RELEASE_REASON,
      keepBranch: false,
    });
    forgetWorkerNotes(deps.office, claim.worktree);
    forgetContextPack(deps.office, claim.worktree);
    const entries = [
      notice(
        "info",
        TEARDOWN_NOTICES.done,
        `${claim.story} is Done: ${how}. dipo removed its worktree and deleted the branch ${claim.branch}.`,
        claim.key,
      ),
    ];
    if (outcome.remoteProblem !== null) {
      entries.push(
        notice(
          "warn",
          TEARDOWN_NOTICES.remoteBranch,
          `dipo could not delete the remote branch ${claim.branch}: ${outcome.remoteProblem}. Delete it by hand (\`git push ${deps.git.settings.remote} --delete ${claim.branch}\`).`,
          claim.key,
        ),
      );
    }
    return entries;
  });
  deps.slots?.free(claim.worktree);
  return outcome;
}

/** The git steps of a teardown, inside one queue item. */
async function removeAll(
  deps: TeardownDeps,
  git: GitSession,
  claim: ClaimRecord,
): Promise<TeardownOutcome> {
  const path = claim.worktree;
  const ours = claimLockReason(claim.runId);
  if (deps.git.adminDirOf(path) !== null) {
    const lock = await lockOf(git, path);
    if (lock !== null && lock !== ours) {
      return {
        ok: false,
        why: `the worktree ${path} is locked by someone else (${lock === "" ? "no reason given" : lock})`,
        files: await dirtyFiles(deps, git, path),
      };
    }
    if (lock === ours) await git.ok(git.repository, ["worktree", "unlock", path]);
    const removed = await git.step(git.repository, ["worktree", "remove", path]);
    if (removed.code !== 0) {
      if (lock === ours) {
        await git.step(git.repository, ["worktree", "lock", "--reason", ours, path]);
      }
      return {
        ok: false,
        why: `git refused to remove the worktree ${path} (${removed.stderr.trim() || `exit ${removed.code}`})`,
        files: await dirtyFiles(deps, git, path),
      };
    }
    deps.git.unpinWorktree(path);
  } else if (existsSync(path)) {
    return {
      ok: false,
      why: `${path} exists but is no longer a worktree of this repository, so dipo leaves it alone`,
      files: [],
    };
  } else {
    deps.git.unpinWorktree(path);
  }

  // The local branch, only now that Done is detected (0010 section 7).
  if ((await revParse(git, `refs/heads/${claim.branch}`)) !== null) {
    const deleted = await git.step(git.repository, ["branch", "-D", claim.branch]);
    if (deleted.code !== 0) {
      return {
        ok: false,
        why: `\`git branch -D ${claim.branch}\` failed (${deleted.stderr.trim() || `exit ${deleted.code}`}); the worktree is gone`,
        files: [],
      };
    }
  }

  // The remote branch (open question 8); the host's auto-delete may already have removed it.
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
  if (pushed.code === 0 || remoteRefMissing(pushed.stderr))
    return { ok: true, remoteProblem: null };
  return { ok: true, remoteProblem: pushed.stderr.trim() || `exit ${pushed.code}` };
}

/** The files `git status` lists in the worktree; empty when it cannot be read. */
async function dirtyFiles(deps: TeardownDeps, git: GitSession, path: string): Promise<string[]> {
  try {
    const location = deps.git.worktreeLocation(path);
    return statusPaths(
      await git.ok(location, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    );
  } catch {
    return [];
  }
}

/**
 * The lock reason of the worktree at `path` from `git worktree list --porcelain -z`: null when it
 * is not locked, "" when it is locked without a reason.
 */
export async function lockOf(git: GitSession, path: string): Promise<string | null> {
  const out = await git.ok(git.repository, ["worktree", "list", "--porcelain", "-z"]);
  return lockInList(out, path);
}

/** Reads the lock of `path` from `worktree list --porcelain -z` output. */
export function lockInList(output: string, path: string): string | null {
  const want = canonicalFuturePath(path);
  let current = false;
  for (const field of output.split("\0")) {
    if (field === "") {
      current = false;
      continue;
    }
    if (field.startsWith("worktree ")) {
      current = canonicalFuturePath(field.slice("worktree ".length)) === want;
      continue;
    }
    if (!current) continue;
    if (field === "locked") return "";
    if (field.startsWith("locked ")) return field.slice("locked ".length);
  }
  return null;
}

/** stderr of a `push --delete` of a branch the remote does not have. */
function remoteRefMissing(stderr: string): boolean {
  return stderr.includes("remote ref does not exist");
}

async function remoteUrl(git: GitSession, remote: string): Promise<string | null> {
  const result = await git.step(git.repository, ["config", "--get", `remote.${remote}.url`]);
  const url = result.stdout.trim();
  return result.code === 0 && url !== "" ? url : null;
}

async function revParse(
  git: GitSession,
  ref: string,
  kind: "commit" | "tree" = "commit",
): Promise<string | null> {
  const name = kind === "commit" ? `${ref}^{commit}` : ref;
  const result = await git.step(git.repository, ["rev-parse", "--verify", "--quiet", name]);
  return result.code === 0 ? result.stdout.trim() : null;
}

function firstLine(text: string): string {
  const end = text.indexOf("\n");
  return (end === -1 ? text : text.slice(0, end)).trim();
}
