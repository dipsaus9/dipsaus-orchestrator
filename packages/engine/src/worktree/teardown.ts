// Teardown of a claimed story that is Done (DIPO-58; 0010 "Teardown" and the dirty-worktree failure
// case; 0007 tier T). Whether it is Done is the one Done check (`done-check.ts`, 0002); the Done
// poll (`done.ts`) calls the teardown once its own PR merged.
//
// Teardown runs as one item of the office git queue. The branch must still be at the tip the
// Done poll judged; a branch that moved since keeps everything. Then `claims.teardown_started_at`
// is recorded, the worktree unlocked (only a lock this claim holds, `dipo <run-id>`) and removed
// with `git worktree remove <path>` without `--force` (with it only for a worktree whose every
// listed file only lags the branch, `lagging.ts`); the local branch is deleted only while it is
// still at the judged tip (`deleteBranch` of the git writer), then the remote branch with a lease on
// the tip dipo pushed (the judged tip, else the story PR's recorded head; `deleteRemoteBranch`), a
// branch the remote no longer has being fine. A worktree git refuses to remove (dirty) or one locked by anyone else keeps everything: the
// lock is put back, the start record cleared, the claim stays live, and the caller gets the files
// `git status` lists for its notice. Only after the git steps the claim is released (`done`), the
// worktree's `worker_notes` and `context_packs` are deleted and its port slot freed. A teardown a
// crash interrupted is finished by the next poll, whose Done check still reads the merged PR. Every
// step is idempotent.

import { existsSync } from "node:fs";

import type { Clock, OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import { statusPaths } from "../git/write";
import { forgetContextPack } from "../context/pack";
import type { OfficeHandle } from "../db/office";
import type { GitSession, OfficeGit } from "../git/office";
import { canonicalFuturePath } from "../git/paths";
import { deleteBranch, deleteRemoteBranch, remoteUrl } from "../git/write";
import { forgetWorkerNotes } from "../prompts/notes";
import { findStoryPr } from "../story-pr/records";

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
  hostUnreachable: "done.hostUnreachable",
} as const;

/** The release reason of a claim whose story reached Done. */
export const DONE_RELEASE_REASON = "done";

/** The PR a teardown names: the claim's story PR that merged. */
export interface MergedPr {
  readonly number: number;
  readonly url: string;
}

/** What the Done poll reads from git about a claim, in one queue item. */
export interface ClaimGitFacts {
  /** The remote's URL, or null without a remote. */
  readonly url: string | null;
  /** `refs/remotes/<remote>/<base>`, or `refs/heads/<base>` without a remote. */
  readonly baseRef: string;
  /** The local branch tip, or null when the branch is gone. */
  readonly tip: string | null;
  /** True when the worktree is neither registered nor on disk. */
  readonly worktreeGone: boolean;
}

/** What the Done poll reads from git about a claim, inside the caller's queue item. */
export async function claimGitFacts(
  officeGit: OfficeGit,
  git: GitSession,
  claim: ClaimRecord,
): Promise<ClaimGitFacts> {
  const { remote } = officeGit.settings;
  const url = await remoteUrl(git, remote);
  return {
    url,
    baseRef: url === null ? `refs/heads/${claim.base}` : `refs/remotes/${remote}/${claim.base}`,
    tip: await revParse(git, `refs/heads/${claim.branch}`),
    worktreeGone: officeGit.adminDirOf(claim.worktree) === null && !existsSync(claim.worktree),
  };
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
 * Tears down the worktree and branch of a claim whose story PR `pr` merged, then releases the
 * claim, deletes its tier T rows and frees its slot. `tip` is the branch tip the Done poll judged (null
 * when the branch was gone): a branch that moved since keeps everything. A dirty or foreign-locked
 * worktree keeps everything too. The caller puts the notices on the office.
 */
export async function tearDown(
  deps: TeardownDeps,
  claim: ClaimRecord,
  pr: MergedPr,
  tip: string | null,
): Promise<TeardownOutcome> {
  const outcome = await deps.git.run((git) => removeAll(deps, git, claim, tip));
  if (!outcome.ok) return outcome;
  const how = `its PR #${pr.number} merged (${pr.url})`;
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
    // `git worktree remove` deletes ignored files, forced or not, and `git status` never lists
    // them: only a whole `node_modules/` and `.DS_Store` may go (DIPO-332, `lagging.ts`). The last
    // step before the removal.
    const ignored = await keptIgnored(deps.git, git, path);
    if (ignored === null || ignored.length > 0) {
      return keep(
        ignored === null
          ? `dipo could not list the ignored files of the worktree ${path}, which git would delete with it`
          : `the worktree ${path} holds ignored files that git would delete with it`,
        ignored ?? [],
      );
    }
    // The window that remains: an edit made in the worktree after the last check above, just
    // before this removal, is lost. Accepted: nothing writes the Mac worktree during a box run (the
    // worker works in its box, and dipo's own writes run in this office git queue).
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
  // at the tip the detection judged.
  if (tip !== null) {
    const deleted = await deleteBranch(git, claim.branch, tip);
    if (deleted.code !== 0) {
      return {
        ok: false,
        why: `deleting the branch ${claim.branch} at ${tip} failed (${deleted.stderr.trim() || `exit ${deleted.code}`}); the worktree is gone`,
        files: [],
      };
    }
  }

  // The remote branch (open question 8), with a lease on the tip dipo pushed: the tip the detection
  // judged (the merged PR's head), else the story PR's recorded head. The host's auto-delete may
  // already have removed it.
  const { remote } = deps.git.settings;
  if ((await remoteUrl(git, remote)) === null) return { ok: true, remoteProblem: null };
  const pushed = tip ?? recordedHeads(deps.office, claim)[0] ?? null;
  if (pushed === null) {
    return {
      ok: true,
      remoteProblem: `dipo knows no tip it pushed for ${claim.branch}, so it does not delete the remote branch`,
    };
  }
  const deleted = await deleteRemoteBranch(git, remote, claim.branch, pushed);
  return { ok: true, remoteProblem: deleted.ok ? null : deleted.problem };
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

async function revParse(git: GitSession, ref: string): Promise<string | null> {
  const result = await git.step(git.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return result.code === 0 ? result.stdout.trim() : null;
}
