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
// Teardown runs as one item of the office git queue. The branch must still be at the tip the
// detection judged; a branch that moved since keeps everything. Then `claims.teardown_started_at`
// is recorded, the worktree unlocked (only a lock this claim holds, `dipo <run-id>`) and removed
// with `git worktree remove <path>` without `--force`; the local branch is deleted only while it is
// still at the judged tip (`git update-ref -d <ref> <tip>`, the forced delete of `branch -D` without
// its race), then `git push <remote> --delete <branch>`, a branch the remote no longer has being
// fine. A worktree git refuses to remove (dirty) or one locked by anyone else keeps everything: the
// lock is put back, the start record cleared, the claim stays live, and the caller gets the files
// `git status` lists for its notice. Only after the git steps the claim is released (`done`), the
// worktree's `worker_notes` and `context_packs` are deleted and its port slot freed. A live claim
// with a recorded start whose worktree and branch are both gone is a teardown a crash interrupted:
// the next poll finishes its release without the host. Every step is idempotent.

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
import { type ClaimRecord, markTeardownStarted, releaseClaim } from "./records";
import type { SlotTable } from "./slots";

/** `engine.notice` codes of Done detection and teardown. */
export const TEARDOWN_NOTICES = {
  done: "teardown.done",
  kept: "teardown.kept",
  parked: "teardown.parked",
  remoteBranch: "teardown.remoteBranch",
  checkFailed: "done.checkFailed",
  unmergedCommits: "done.unmergedCommits",
  claimGone: "done.claimGone",
  statusUnknown: "teardown.statusUnknown",
} as const;

/** The release reason of a claim whose story reached Done. */
export const DONE_RELEASE_REASON = "done";

/** How Done was detected. `resumed` is a teardown a crash interrupted after its git steps. */
export type DoneEvidence =
  | { readonly by: "host"; readonly number: number; readonly url: string }
  | { readonly by: "merge-tree"; readonly tree: string }
  | { readonly by: "resumed"; readonly startedAt: number };

/** A problem the detection reports as a notice; the story stays where it is. */
export interface DoneProblem {
  readonly code: string;
  readonly text: string;
}

export type DoneCheck =
  | {
      readonly done: true;
      readonly evidence: DoneEvidence;
      /**
       * The local branch tip the detection judged, or null when the branch was already gone. The
       * teardown deletes the branch only while it is still at this commit.
       */
      readonly tip: string | null;
    }
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
  /** True when the worktree is neither registered nor on disk. */
  readonly worktreeGone: boolean;
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
      worktreeGone: deps.git.adminDirOf(claim.worktree) === null && !existsSync(claim.worktree),
    };
  });
  const gone = facts.tip === null && facts.worktreeGone;
  // A teardown this engine started and a crash interrupted: its git steps already ran.
  if (gone && claim.teardownStartedAt !== null) {
    return {
      done: true,
      evidence: { by: "resumed", startedAt: claim.teardownStartedAt },
      tip: null,
    };
  }

  let mergedElsewhere: number | null = null;
  const repo = facts.url === null ? null : repoOfRemoteUrl(facts.url);
  if (deps.host !== null && repo !== null) {
    try {
      const pr = await deps.host.findMergedPr(repo, claim.branch);
      if (pr !== null && pr.base === claim.base) {
        if (facts.tip === null || pr.headSha === facts.tip) {
          return {
            done: true,
            evidence: { by: "host", number: pr.number, url: pr.url },
            tip: facts.tip,
          };
        }
        mergedElsewhere = pr.number;
      }
    } catch (error) {
      // The host is unreachable or gh is unusable: merge-tree still decides, the next poll asks again.
      if (!(error instanceof CodeHostError)) throw error;
    }
  }

  if (gone) {
    return {
      done: false,
      problem: {
        code: TEARDOWN_NOTICES.claimGone,
        text: `${claim.story} is claimed, but its worktree ${claim.worktree} and branch ${claim.branch} are both gone and dipo cannot tell whether it merged. Check the story by hand.`,
      },
    };
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
    ? { done: true, evidence: { by: "merge-tree", tree: baseTree }, tip: facts.tip }
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
 * deletes its tier T rows and frees its slot. `tip` is the branch tip the detection judged (null
 * when the branch was gone): a branch that moved since keeps everything. A dirty or foreign-locked
 * worktree keeps everything too. The caller puts the notices on the office.
 */
export async function tearDown(
  deps: TeardownDeps,
  claim: ClaimRecord,
  evidence: DoneEvidence,
  tip: string | null,
): Promise<TeardownOutcome> {
  const outcome = await deps.git.run((git) => removeAll(deps, git, claim, tip));
  if (!outcome.ok) return outcome;
  const how =
    evidence.by === "host"
      ? `its PR #${evidence.number} merged (${evidence.url})`
      : evidence.by === "merge-tree"
        ? "its branch adds nothing to the base"
        : "dipo finishes the teardown it started earlier";
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

/** What the worktree steps of a teardown report. */
export type WorktreeOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly why: string;
      readonly files: readonly string[];
    };

/**
 * The worktree steps of a teardown, inside one queue item: records `teardown_started_at`, unlocks
 * the worktree (only a lock this claim holds), removes it with `git worktree remove` without
 * `--force` and unpins it. A worktree git refuses to remove or one locked by anyone else keeps
 * everything: the lock is put back and the start record cleared. A worktree already gone is fine.
 */
export async function removeWorktree(
  deps: Pick<TeardownDeps, "office" | "git" | "clock">,
  git: GitSession,
  claim: ClaimRecord,
): Promise<WorktreeOutcome> {
  const path = claim.worktree;
  const ours = claimLockReason(claim.runId);
  const mark = (at: number | null) =>
    deps.office.immediate(() => markTeardownStarted(deps.office, claim.runId, at));
  if (deps.git.adminDirOf(path) !== null) {
    const lock = await lockOf(git, path);
    if (lock !== null && lock !== ours) {
      // A start an earlier crash left behind is cleared too, so the claim reads as live again.
      if (claim.teardownStartedAt !== null) mark(null);
      return {
        ok: false,
        why: `the worktree ${path} is locked by someone else (${lock === "" ? "no reason given" : lock})`,
        files: await dirtyFiles(deps, git, claim),
      };
    }
    // Recorded before the first step that removes anything, so a crash after it is resumable.
    mark(deps.clock.now());
    if (lock === ours) await git.ok(git.repository, ["worktree", "unlock", path]);
    // Changes that only reflect the branch moving (DIPO-302) are not work; git would refuse them.
    const moved =
      (await statusFiles(deps, git, path)).length > 0 &&
      (await filesAtBranchMove(deps, git, claim));
    const removed = await git.step(git.repository, [
      "worktree",
      "remove",
      ...(moved ? ["--force"] : []),
      path,
    ]);
    if (removed.code !== 0) {
      if (lock === ours) {
        await git.step(git.repository, ["worktree", "lock", "--reason", ours, path]);
      }
      mark(null);
      return {
        ok: false,
        why: `git refused to remove the worktree ${path} (${removed.stderr.trim() || `exit ${removed.code}`})`,
        files: await dirtyFiles(deps, git, claim),
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
    mark(claim.teardownStartedAt ?? deps.clock.now());
    deps.git.unpinWorktree(path);
  }
  return { ok: true };
}

/** The git steps of a teardown, inside one queue item. */
async function removeAll(
  deps: TeardownDeps,
  git: GitSession,
  claim: ClaimRecord,
  tip: string | null,
): Promise<TeardownOutcome> {
  const ref = `refs/heads/${claim.branch}`;
  // The branch must still be where the detection judged it; a commit since then is kept.
  const current = await revParse(git, ref);
  if (current !== tip) {
    return {
      ok: false,
      why: `the branch ${claim.branch} moved from ${tip ?? "(gone)"} to ${current ?? "(gone)"} after Done was detected; dipo checks it again on its next poll`,
      files: [],
    };
  }
  const worktree = await removeWorktree(deps, git, claim);
  if (!worktree.ok) return worktree;

  // The local branch, only now that Done is detected (0010 section 7), and only while it is still
  // at the tip the detection judged (`git update-ref -d` with the old value, like `branch -D`
  // without its race).
  if (tip !== null) {
    const deleted = await git.step(git.repository, ["update-ref", "-d", ref, tip]);
    if (deleted.code !== 0) {
      return {
        ok: false,
        why: `deleting the branch ${claim.branch} at ${tip} failed (${deleted.stderr.trim() || `exit ${deleted.code}`}); the worktree is gone`,
        files: [],
      };
    }
    // `branch -D` also drops the branch's configuration (upstream, merge); `update-ref` does not.
    // A branch without any is fine (exit 5 or 128, "no such section").
    await git.step(git.repository, ["config", "--remove-section", `branch.${claim.branch}`]);
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

/**
 * The files `git status` lists in the claim's worktree, or none when they only reflect the branch
 * moving (see `filesAtBranchMove`); empty when it cannot be read.
 */
export async function dirtyFiles(
  deps: Pick<TeardownDeps, "git">,
  git: GitSession,
  claim: Pick<ClaimRecord, "branch" | "startSha" | "worktree">,
): Promise<string[]> {
  const status = await statusFiles(deps, git, claim.worktree);
  return status.length === 0 || (await filesAtBranchMove(deps, git, claim)) ? [] : status;
}

/** The files `git status` lists in the worktree at `path`; empty when it cannot be read. */
async function statusFiles(
  deps: Pick<TeardownDeps, "git">,
  git: GitSession,
  path: string,
): Promise<string[]> {
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
 * Whether the claim's worktree holds the start commit's files or the branch tip's, with no
 * untracked file (DIPO-302). A box run moves the branch with `update-ref` for each part and leaves
 * the worktree at the start commit, so `git status` lists the parts reversed as staged changes
 * while the files hold nothing new. Such a worktree is clean. False when it cannot be read.
 */
export async function filesAtBranchMove(
  deps: Pick<TeardownDeps, "git">,
  git: GitSession,
  claim: Pick<ClaimRecord, "branch" | "startSha" | "worktree">,
): Promise<boolean> {
  try {
    const location = deps.git.worktreeLocation(claim.worktree);
    const untracked = await git.ok(location, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (untracked !== "") return false;
    const tip = await revParse(git, `refs/heads/${claim.branch}`);
    for (const commit of [claim.startSha, tip]) {
      if (commit === null) continue;
      const changed = await git.ok(location, ["diff", "--name-only", "-z", commit]);
      if (changed === "") return true;
    }
    return false;
  } catch {
    return false;
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
export function remoteRefMissing(stderr: string): boolean {
  return stderr.includes("remote ref does not exist");
}

export async function remoteUrl(git: GitSession, remote: string): Promise<string | null> {
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
