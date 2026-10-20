// A claimed story that is Done on `_base` (DIPO-216; 0020 section 10, the minimal release): a story
// finished through another branch, for example a `-finish` branch, never reaches Done through its
// own, so the Done poll never releases its claim and its worktree keeps its port slot. Reconcile
// finds each live claim with a claim commit whose run has ended and whose story the index pass
// read as Done on `_base`, and, in one item of the office git queue that checks both again, reuses
// the worktree steps of the teardown (`removeWorktree`): `teardown_started_at` is recorded, the
// claim's own lock is removed and the worktree is removed without `--force`. Then, in one
// transaction, the claim is released as `done` (the reason the own-branch path writes), an open
// park of the run is resolved `reconcile`, the worktree's tier T rows are forgotten and an info
// notice is written; last the port slot is freed. A worktree git refuses to remove, or one locked
// by anyone else, is kept with its claim and slot and a warn notice that names its path and files.
// No branch is touched: the local and the remote branch keep their commits (DIPO-162 handles them).
// A claim with `teardown_started_at` whose worktree is already gone (a crash between the removal and
// the release) is released the same way without git.

import { existsSync } from "node:fs";

import { forgetContextPack } from "../context/pack";
import { findRun } from "../run/records";
import type { IndexResult } from "../stories/index-stories";
import { forgetWorkerNotes } from "../prompts/notes";
import { lifecycleOf } from "../views/story";
import { type ClaimRecord, findClaim, liveClaims, releaseClaim } from "../worktree/records";
import { DONE_RELEASE_REASON, removeWorktree } from "../worktree/teardown";

import type { ReconcileDeps, ReconcileFinding } from "./reconcile";

/** `engine.notice` codes of this step. */
export const DONE_ON_BASE_NOTICES = {
  released: "reconcile.doneOnBase",
  kept: "reconcile.doneOnBaseKept",
} as const;

type Recorder = (finding: ReconcileFinding, facts?: () => void, level?: "info" | "warn") => void;

/** The status of the claim's story on `_base` in `pass`, or undefined when the pass has none. */
function baseStatusOf(pass: IndexResult, claim: ClaimRecord): string | undefined {
  const onBranch = pass.baseStatus.get(claim.key);
  if (onBranch !== undefined) return onBranch;
  // A claim whose teardown started is read on `_base` like an unclaimed story.
  return pass.read.find((story) => story.story === claim.story && story.kind === "task")?.status;
}

function isDoneOnBase(status: string | undefined): boolean {
  return status !== undefined && lifecycleOf("task", status) === "Done";
}

function runEnded(deps: ReconcileDeps, claim: ClaimRecord): boolean {
  const run = findRun(deps.office, claim.runId);
  return run !== null && run.endedAt !== null;
}

/** True while the claim is still live with a claim commit, and its run has ended. */
function stillEligible(deps: ReconcileDeps, claim: ClaimRecord): boolean {
  const current = findClaim(deps.office, claim.runId);
  return (
    current !== null &&
    current.releasedAt === null &&
    current.claimSha !== null &&
    runEnded(deps, current)
  );
}

/** What one pass of `releaseDoneOnBase` did: the claims released, and those skipped because `_base` moved. */
export interface DoneOnBaseResult {
  readonly released: number;
  readonly baseMoved: number;
}

/** The outcome of one claim: released, skipped because `_base` moved since the pass, or left alone. */
type ClaimOutcome = "released" | "baseMoved" | "none";

/**
 * Releases the claims of stories Done on `_base`; returns how many it released and how many it
 * skipped because the HEAD of `_base` was not the pass's commit. `record` writes a notice with its
 * facts in one transaction.
 */
export async function releaseDoneOnBase(
  deps: ReconcileDeps,
  pass: IndexResult,
  record: Recorder,
): Promise<DoneOnBaseResult> {
  let released = 0;
  let baseMoved = 0;
  for (const claim of liveClaims(deps.office)) {
    if (claim.claimSha === null || !runEnded(deps, claim)) continue;
    if (!isDoneOnBase(baseStatusOf(pass, claim))) continue;
    try {
      const outcome = await releaseOne(deps, pass, claim, record);
      if (outcome === "released") released += 1;
      if (outcome === "baseMoved") baseMoved += 1;
    } catch (error) {
      record({
        code: DONE_ON_BASE_NOTICES.kept,
        key: claim.key,
        text: `${claim.story} is Done on ${claim.base}, but dipo could not release its claim: ${error instanceof Error ? error.message : String(error)}. It keeps the claim, worktree ${claim.worktree} and port slot; dipo tries again at the next rescan.`,
      });
    }
  }
  return { released, baseMoved };
}

async function releaseOne(
  deps: ReconcileDeps,
  pass: IndexResult,
  claim: ClaimRecord,
  record: Recorder,
): Promise<ClaimOutcome> {
  const { git, office } = deps;
  const gone =
    claim.teardownStartedAt !== null &&
    git.adminDirOf(claim.worktree) === null &&
    !existsSync(claim.worktree);
  if (!gone) {
    const outcome = await git.run(async (session) => {
      // Checked again inside the queue item: a run reopened since the pass, or a `_base` that moved
      // since the pass read it, keeps everything.
      if (!stillEligible(deps, claim)) return "skipped" as const;
      const head = await session
        .ok(git.worktreeLocation(git.baseWorktreePath()), ["rev-parse", "--verify", "HEAD"])
        .then((out) => out.trim())
        .catch(() => null);
      if (head !== pass.sha) return "baseMoved" as const;
      return removeWorktree({ office, git, clock: deps.clock }, session, claim);
    });
    if (outcome === "skipped") return "none";
    if (outcome === "baseMoved") return "baseMoved";
    if (!outcome.ok) {
      const files =
        outcome.files.length === 0 ? "" : ` Files git lists there: ${outcome.files.join(", ")}.`;
      record({
        code: DONE_ON_BASE_NOTICES.kept,
        key: claim.key,
        text: `${claim.story} is Done on ${claim.base}, but dipo kept its claim, worktree ${claim.worktree} and port slot: ${outcome.why}.${files} Commit, move or remove those changes; dipo tries again at the next rescan.`,
      });
      return "none";
    }
  } else if (!stillEligible(deps, claim)) {
    return "none";
  }

  record(
    {
      code: DONE_ON_BASE_NOTICES.released,
      key: claim.key,
      text: `${claim.story} is Done on ${claim.base}, but not through its own branch ${claim.branch}; dipo released its claim and removed its worktree ${claim.worktree}. The branch is kept.`,
    },
    () => {
      const at = deps.clock.now();
      releaseClaim(office, claim.runId, {
        at,
        reason: DONE_RELEASE_REASON,
        keepBranch: false,
      });
      office.run(
        `update parks set resolved_at = $at, resolved_how = 'reconcile'
          where office_id = $office_id and run_id = $run and resolved_at is null`,
        { run: claim.runId, at },
      );
      forgetWorkerNotes(office, claim.worktree);
      forgetContextPack(office, claim.worktree);
    },
    "info",
  );
  deps.slots?.free(claim.worktree);
  return "released";
}
