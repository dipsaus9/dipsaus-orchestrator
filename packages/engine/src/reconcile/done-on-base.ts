// A claimed story that is Done on `_base` (DIPO-216, the minimal release; DIPO-161, 0020 section
// 10): a story finished through another branch, for example a `-finish` branch, never reaches Done
// through its own, so the Done poll never tears it down. Reconcile finds each live claim with a
// claim commit whose story the index pass read as Done on `_base`:
//
// - A claim whose worker is live (its run active, or a worker host not ended) is not stopped: it is
//   flagged once (a DONE ELSEWHERE desk item and a notice) and released when the run next ends.
// - A claim Done through its own branch (its story PR recorded merged, or `git merge-tree` finding
//   nothing new on it) is left to the Done poll, which tears it down as `done` (DIPO-332): after
//   the merge slot merged a PR, the next index pass reads the story Done on `_base` too. One whose
//   branch moved past its merged PR's head with changes the base lacks is released as `done` and
//   its worktree and branch settled as leftovers (`releaseMovedPastMerge`).
// - A parked or idle claim is checked again in one item of the office git queue (still live, its
//   run ended, `_base` still at the pass's commit, else it is retried after a reindex, DIPO-226),
//   which also reads the base commit that last changed the task file. Then it is released as
//   `done-elsewhere` in one transaction and its PR, worktree and branch are settled
//   (`worktree/done-elsewhere.ts`): a clean worktree is removed and a dirty one kept as leftovers
//   while the claim is released; a branch that adds nothing to the base is deleted locally and on
//   the remote, else kept in `released_branches`. This replaces DIPO-216's interim release (reason
//   `done`, park resolved `reconcile`, a dirty worktree keeping its claim live) for these claims.
// - A claim with `teardown_started_at` whose worktree is already gone (an own-branch teardown a
//   crash interrupted between the removal and the release) is released as `done` without git, as
//   DIPO-216 does; its branch is then settled like the leftovers above.
// - A claim DIPO-216 released that way before this story, whose local branch is still there, gets
//   the same branch handling (`sweepCrashedTeardowns`).
// Released rows a crash left unsettled are settled first (`settlePending`).

import { existsSync } from "node:fs";

import { findRun } from "../run/records";
import type { IndexResult } from "../stories/index-stories";
import { lifecycleOf } from "../views/story";
import {
  adoptReleased,
  type DoneElsewhereDeps,
  findDoneElsewhere,
  flagLiveWorker,
  hasLiveWorker,
  lastTaskCommit,
  releaseDoneElsewhere,
  releaseMovedPastMerge,
  settleDoneElsewhere,
  settlePending,
} from "../worktree/done-elsewhere";
import { type ClaimRecord, findClaim, liveClaimOf, liveClaims } from "../worktree/records";
import { DONE_RELEASE_REASON, doneOnOwnBranchIn, ownMergedPr } from "../worktree/teardown";

import type { ReconcileDeps, ReconcileFinding } from "./reconcile";

/** `engine.notice` codes of this step. */
export const DONE_ON_BASE_NOTICES = {
  released: "reconcile.doneOnBase",
  kept: "reconcile.doneOnBaseKept",
} as const;

type Recorder = (finding: ReconcileFinding, facts?: () => void, level?: "info" | "warn") => void;

/** The status of the claim's story on `_base` in `pass`, or undefined when the pass has none. */
function baseStatusOf(
  pass: IndexResult,
  claim: Pick<ClaimRecord, "key" | "story">,
): string | undefined {
  const onBranch = pass.baseStatus.get(claim.key);
  if (onBranch !== undefined) return onBranch;
  // A claim whose teardown started, or a released one, is read on `_base` like an unclaimed story.
  return pass.read.find((story) => story.story === claim.story && story.kind === "task")?.status;
}

function isDoneOnBase(status: string | undefined): boolean {
  return status !== undefined && lifecycleOf("task", status) === "Done";
}

function runEnded(deps: ReconcileDeps, claim: ClaimRecord): boolean {
  const run = findRun(deps.office, claim.runId);
  return run !== null && run.endedAt !== null;
}

/** True while the claim is still live with a claim commit, and no worker of its run is live. */
function stillEligible(deps: ReconcileDeps, claim: ClaimRecord): boolean {
  const current = findClaim(deps.office, claim.runId);
  return (
    current !== null &&
    current.releasedAt === null &&
    current.claimSha !== null &&
    runEnded(deps, current) &&
    !hasLiveWorker(deps.office, current)
  );
}

/** What one pass of `releaseDoneOnBase` did: the claims released, and those skipped because `_base` moved. */
export interface DoneOnBaseResult {
  readonly released: number;
  readonly baseMoved: number;
  /** The run ids of the claims skipped because `_base` moved, for the retry to look at only those. */
  readonly skippedRuns: readonly string[];
}

/** The outcome of one claim: released, skipped because `_base` moved since the pass, or left alone. */
type ClaimOutcome = "released" | "baseMoved" | "none";

/** The deps of the done-elsewhere steps, from reconcile's; `found` hears each notice. */
function elsewhereDeps(
  deps: ReconcileDeps,
  found?: (finding: ReconcileFinding) => void,
): DoneElsewhereDeps {
  return {
    ...(found === undefined ? {} : { onNotice: found }),
    officeId: deps.officeId,
    office: deps.office,
    git: deps.git,
    clock: deps.clock,
    ...(deps.slots === undefined ? {} : { slots: deps.slots }),
    ...(deps.host === undefined ? {} : { host: deps.host }),
    ...(deps.finishBoxes === undefined ? {} : { finishBoxes: deps.finishBoxes }),
  };
}

/**
 * Releases the claims of stories Done on `_base`; returns how many it released and how many it
 * skipped because the HEAD of `_base` was not the pass's commit, with the run ids of the skipped
 * ones. `only`, when given, limits the pass to the claims of those run ids. `record` writes a notice
 * with its facts in one transaction; `found` hears the notices the done-elsewhere steps write.
 */
export async function releaseDoneOnBase(
  deps: ReconcileDeps,
  pass: IndexResult,
  record: Recorder,
  only?: ReadonlySet<string>,
  found?: (finding: ReconcileFinding) => void,
): Promise<DoneOnBaseResult> {
  let released = 0;
  const skippedRuns: string[] = [];
  const elsewhere = elsewhereDeps(deps, found);
  if (only === undefined) await settlePending(elsewhere);
  for (const claim of liveClaims(deps.office)) {
    if (only !== undefined && !only.has(claim.runId)) continue;
    if (claim.claimSha === null) continue;
    if (!isDoneOnBase(baseStatusOf(pass, claim))) continue;
    try {
      const outcome = await releaseOne(deps, elsewhere, pass, claim);
      if (outcome === "released") released += 1;
      if (outcome === "baseMoved") skippedRuns.push(claim.runId);
    } catch (error) {
      record({
        code: DONE_ON_BASE_NOTICES.kept,
        key: claim.key,
        text: `${claim.story} is Done on ${claim.base}, but dipo could not release its claim: ${error instanceof Error ? error.message : String(error)}. dipo tries again at the next rescan.`,
      });
    }
  }
  if (only === undefined) await sweepCrashedTeardowns(deps, elsewhere, pass, record);
  return { released, baseMoved: skippedRuns.length, skippedRuns };
}

async function releaseOne(
  deps: ReconcileDeps,
  elsewhere: DoneElsewhereDeps,
  pass: IndexResult,
  claim: ClaimRecord,
): Promise<ClaimOutcome> {
  const { git, office } = deps;
  if (hasLiveWorker(office, claim)) {
    // The worker is not stopped by code (0020 section 10): a desk item, once, and the release
    // follows at the run's next end.
    if (findDoneElsewhere(office, claim.runId) !== null) return "none";
    const commit = await git.run((session) => lastTaskCommit(session, pass.sha, claim.story));
    flagLiveWorker(elsewhere, claim, commit);
    return "none";
  }
  const gone =
    claim.teardownStartedAt !== null &&
    git.adminDirOf(claim.worktree) === null &&
    !existsSync(claim.worktree);
  if (gone) {
    if (!stillEligible(deps, claim)) return "none";
    // DIPO-216: released as `done` without git; the branch is settled after the release.
    releaseDoneElsewhere(elsewhere, claim, null, {
      reason: DONE_RELEASE_REASON,
      text: `${claim.story} is Done on ${claim.base}, but not through its own branch ${claim.branch}; dipo released its claim, whose worktree ${claim.worktree} was already removed.`,
    });
  } else {
    const checked = await git.run(async (session) => {
      // Checked again inside the queue item: a run reopened since the pass, or a `_base` that moved
      // since the pass read it, keeps everything.
      if (!stillEligible(deps, claim)) return "skipped" as const;
      const head = await session
        .ok(git.worktreeLocation(git.baseWorktreePath()), ["rev-parse", "--verify", "HEAD"])
        .then((out) => out.trim())
        .catch(() => null);
      if (head !== pass.sha) return "baseMoved" as const;
      // Done through its own branch (its PR merged, or merge-tree finds nothing new on it) is the
      // Done poll's to tear down as `done`, never a release as done elsewhere (DIPO-332). A branch
      // that moved past its merged PR's head with changes the base lacks becomes leftovers.
      const own = await doneOnOwnBranchIn(office, git, session, claim);
      if (own === "done") return "skipped" as const;
      if (own === "movedPast") return "movedPast" as const;
      return { commit: await lastTaskCommit(session, pass.sha, claim.story) };
    });
    if (checked === "skipped") return "none";
    if (checked === "baseMoved") return "baseMoved";
    if (checked === "movedPast") {
      const pr = ownMergedPr(office, claim);
      if (pr === null) return "none";
      await releaseMovedPastMerge(elsewhere, claim, pr);
      return "released";
    }
    releaseDoneElsewhere(elsewhere, claim, checked.commit);
  }
  const row = findDoneElsewhere(office, claim.runId);
  if (row !== null) await settleDoneElsewhere(elsewhere, row);
  return "released";
}

/**
 * Own-branch teardowns a crash interrupted after removing the worktree and that DIPO-216 released
 * as `done` while their local branch stayed (AC10): each such claim, whose story is Done on the
 * base and which has no row yet, gets one and its branch settled. Returns how many it settled.
 */
async function sweepCrashedTeardowns(
  deps: ReconcileDeps,
  elsewhere: DoneElsewhereDeps,
  pass: IndexResult,
  record: Recorder,
): Promise<number> {
  const candidates = deps.office
    .all<{ run_id: string }>(
      `select c.run_id as run_id from claims c
        where c.office_id = $office_id and c.released_at is not null
          and c.release_reason = $reason and c.teardown_started_at is not null
          and not exists (select 1 from done_elsewhere d
            where d.office_id = c.office_id and d.run_id = c.run_id)
        order by c.released_at`,
      { reason: DONE_RELEASE_REASON },
    )
    .map((row) => findClaim(deps.office, row.run_id as ClaimRecord["runId"]))
    .filter((claim): claim is ClaimRecord => claim !== null)
    .filter((claim) => liveClaimOf(deps.office, claim.key) === null)
    .filter((claim) => isDoneOnBase(baseStatusOf(pass, claim)));
  if (candidates.length === 0) return 0;
  const branches = await deps.git.run(async (session) => {
    const out = await session.ok(session.repository, [
      "for-each-ref",
      "--format=%(refname:strip=2)",
      "refs/heads/",
    ]);
    return new Set(out.split("\n").filter((line) => line !== ""));
  });
  let settled = 0;
  for (const claim of candidates) {
    if (!branches.has(claim.branch)) continue;
    try {
      const commit = await deps.git.run((session) =>
        lastTaskCommit(session, pass.sha, claim.story),
      );
      adoptReleased(elsewhere, claim, commit);
      const row = findDoneElsewhere(deps.office, claim.runId);
      if (row !== null) await settleDoneElsewhere(elsewhere, row);
      settled += 1;
    } catch (error) {
      record({
        code: DONE_ON_BASE_NOTICES.kept,
        key: claim.key,
        text: `${claim.story} is Done on ${claim.base}, but dipo could not check its kept branch ${claim.branch}: ${error instanceof Error ? error.message : String(error)}. dipo tries again at the next rescan.`,
      });
    }
  }
  return settled;
}
