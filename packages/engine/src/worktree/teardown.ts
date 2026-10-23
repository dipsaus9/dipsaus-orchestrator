// Done detection and teardown of a claimed story (DIPO-58; 0010 section 7, "Merge and Done",
// "Teardown" and the dirty-worktree failure case, open question 8; 0007 section 7, tier T).
//
// Done is detected in one of two ways, never by ancestry:
// - the host reports a merged PR whose head is the story branch, into the claim's base, and whose
//   head commit is the local branch tip (or the local branch is already gone); without the host's
//   answer, the claim's own story PR that dipo recorded merged counts the same (DIPO-332);
// - `git merge-tree --write-tree origin/<base> <branch>` exits 0 and prints the tree of
//   `origin/<base>`: the branch adds nothing new. A branch still at the commit it started from has
//   nothing of its own and is never Done this way.
//
// Teardown runs as one item of the office git queue. The branch must still be at the tip the
// detection judged; a branch that moved since keeps everything. Then `claims.teardown_started_at`
// is recorded, the worktree unlocked (only a lock this claim holds, `dipo <run-id>`) and removed
// with `git worktree remove <path>` without `--force` (with it only for a worktree whose every
// listed file only lags the branch, `lagging.ts`); the local branch is deleted only while it is
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
import { findStoryPr, type StoryPrRecord } from "../story-pr/records";

import { notice, writeWith } from "./claim";
import { keptIgnored, type LagClaim, unlaggedPaths } from "./lagging";
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
  /**
   * The office, for the claim's own story PR as dipo recorded it (DIPO-332): a PR the PR poll
   * recorded merged counts like the host's answer when the host gives none (no host, unreachable,
   * or no merged PR found).
   */
  readonly office?: OfficeHandle;
}

/**
 * The claim's own story PR when dipo recorded it merged into the claim's base from the claim's
 * branch (DIPO-332): the story is Done on the base through its own branch, never elsewhere.
 */
export function ownMergedPr(
  office: OfficeHandle,
  claim: Pick<ClaimRecord, "runId" | "branch" | "base">,
): StoryPrRecord | null {
  const pr = findStoryPr(office, claim.runId);
  return pr !== null &&
    pr.state === "merged" &&
    pr.branch === claim.branch &&
    pr.base === claim.base
    ? pr
    : null;
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
  const facts = await deps.git.run((git) => branchFacts(deps.git, git, claim));
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
  let merged: Pick<StoryPrRecord, "number" | "url" | "headSha" | "base"> | null = null;
  if (deps.host !== null && repo !== null) {
    try {
      merged = await deps.host.findMergedPr(repo, claim.branch);
    } catch (error) {
      // The host is unreachable or gh is unusable: merge-tree still decides, the next poll asks again.
      if (!(error instanceof CodeHostError)) throw error;
    }
  }
  // Without the host's answer, the PR dipo recorded merged (DIPO-332): after the base moved on, a
  // squash-merged branch can conflict with it, so merge-tree alone no longer sees it Done.
  if (merged === null && deps.office !== undefined) merged = ownMergedPr(deps.office, claim);
  if (merged !== null && merged.base === claim.base) {
    if (facts.tip === null || merged.headSha === facts.tip) {
      return {
        done: true,
        evidence: { by: "host", number: merged.number, url: merged.url },
        tip: facts.tip,
      };
    }
    mergedElsewhere = merged.number;
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

/** What the detection reads from git, inside the caller's queue item. */
async function branchFacts(
  officeGit: OfficeGit,
  git: GitSession,
  claim: ClaimRecord,
): Promise<BranchFacts> {
  const { remote } = officeGit.settings;
  const url = await remoteUrl(git, remote);
  return {
    url,
    baseRef: url === null ? `refs/heads/${claim.base}` : `refs/remotes/${remote}/${claim.base}`,
    tip: await revParse(git, `refs/heads/${claim.branch}`),
    worktreeGone: officeGit.adminDirOf(claim.worktree) === null && !existsSync(claim.worktree),
  };
}

/**
 * Whether the claim's story is Done through its own branch, without asking the host, inside the
 * caller's queue item (DIPO-332): `done` when its own story PR is recorded merged at the local tip
 * (or the branch is gone), or the `merge-tree` rule finds it Done, or that rule cannot run while
 * the PR is recorded merged (the Done poll reports it); `movedPast` when the PR is recorded merged
 * but the branch moved past that head with changes the base does not have; `no` otherwise.
 */
export async function doneOnOwnBranchIn(
  office: OfficeHandle,
  officeGit: OfficeGit,
  git: GitSession,
  claim: ClaimRecord,
): Promise<"done" | "movedPast" | "no"> {
  const own = ownMergedPr(office, claim);
  const facts = await branchFacts(officeGit, git, claim);
  if (own !== null && (facts.tip === null || facts.tip === own.headSha)) return "done";
  const tree = await mergeTreeDone(git, facts, claim);
  if (tree.done) return "done";
  if (own === null) return "no";
  return tree.problem === undefined ? "movedPast" : "done";
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
 * The one exception to "without `--force`" is a worktree whose every listed path only lags its
 * branch (`unlaggedPaths`, DIPO-302 and DIPO-332): a box run's worktree after its parts. A worktree
 * with ignored files that are not rebuildable (`keptIgnored`) keeps everything too.
 */
export async function removeWorktree(
  deps: Pick<TeardownDeps, "office" | "git" | "clock">,
  git: GitSession,
  claim: ClaimRecord,
): Promise<WorktreeOutcome> {
  const path = claim.worktree;
  const ours = claimLockReason(claim.runId);
  const heads = recordedHeads(deps.office, claim);
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
        files: await dirtyFiles(deps, git, claim, heads),
      };
    }
    // Recorded before the first step that removes anything, so a crash after it is resumable.
    mark(deps.clock.now());
    if (lock === ours) await git.ok(git.repository, ["worktree", "unlock", path]);
    /** Keeps everything: the lock put back and the start record cleared. */
    const keep = async (why: string, files: readonly string[]): Promise<WorktreeOutcome> => {
      if (lock === ours) {
        await git.step(git.repository, ["worktree", "lock", "--reason", ours, path]);
      }
      mark(null);
      return { ok: false, why, files };
    };
    // Changes that only reflect the branch moving are not work; git would refuse them. Only a
    // worktree proven to hold nothing of its own is removed with `--force`.
    const listed = await statusFiles(deps, git, path);
    const lagging =
      listed.length > 0 && (await unlaggedPaths(deps.git, git, claim, heads))?.length === 0;
    // `git worktree remove` deletes ignored files, forced or not, and `git status` never lists
    // them: only a whole `node_modules/` and `.DS_Store` may go (DIPO-332, `lagging.ts`). Checked
    // right before the removal.
    const ignored = await keptIgnored(deps.git, git, path);
    if (ignored === null || ignored.length > 0) {
      return keep(
        ignored === null
          ? `dipo could not list the ignored files of the worktree ${path}, which git would delete with it`
          : `the worktree ${path} holds ignored files that git would delete with it`,
        ignored ?? [],
      );
    }
    if (lagging) {
      // Once more right before the forced removal: anything that changed since keeps everything.
      const again = await statusFiles(deps, git, path);
      const still =
        again.length === listed.length &&
        again.every((file, at) => file === listed[at]) &&
        (await unlaggedPaths(deps.git, git, claim, heads))?.length === 0;
      if (!still) {
        return keep(
          `the worktree ${path} changed while dipo checked it`,
          await dirtyFiles(deps, git, claim, heads),
        );
      }
    }
    const removed = await git.step(git.repository, [
      "worktree",
      "remove",
      ...(lagging ? ["--force"] : []),
      path,
    ]);
    if (removed.code !== 0) {
      return keep(
        `git refused to remove the worktree ${path} (${removed.stderr.trim() || `exit ${removed.code}`})`,
        await dirtyFiles(deps, git, claim, heads),
      );
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
 * The files of the claim's worktree that hold changes of its own: of the files `git status` lists,
 * those that do not only lag the branch (`unlaggedPaths`), or every listed file when dipo cannot
 * tell; empty when the worktree is clean, only lags, or cannot be read. `heads` are more commits
 * dipo made on the branch (`recordedHeads`).
 */
export async function dirtyFiles(
  deps: Pick<TeardownDeps, "git">,
  git: GitSession,
  claim: LagClaim,
  heads: readonly string[] = [],
): Promise<string[]> {
  const status = await statusFiles(deps, git, claim.worktree);
  if (status.length === 0) return [];
  return (await unlaggedPaths(deps.git, git, claim, heads)) ?? status;
}

/**
 * The heads dipo pushed for the claim's run (its story PR's last pushed head), so a worktree whose
 * branch is already gone is still compared with the commits dipo made (DIPO-332).
 */
export function recordedHeads(
  office: OfficeHandle,
  claim: Pick<ClaimRecord, "runId" | "branch">,
): string[] {
  const pr = findStoryPr(office, claim.runId);
  return pr === null || pr.branch !== claim.branch || pr.headSha === "" ? [] : [pr.headSha];
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
