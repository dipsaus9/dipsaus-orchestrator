// The facts of review rounds (0019 sections 4, 6 and 12, DIPO-219), read and written through the
// office handle. Writers run inside the caller's transaction.
//
// - Pending reviews. A story run that ended at In Review, whose claim is live and whose run keeps
//   the review loop's caps, waits for a review while its code tree key (recorded on its green
//   verify) has no verdict in the claim. It is not pending until its head is on the remote
//   (DIPO-315): the claim's `pushed_at` at or after the run's end, or `no_remote_at` there when the
//   office has no remote. A failed In Review push holds the review until the PR poll pushes again. It waits from its In Review time, so the reviewer place
//   starts the oldest In Review first. A tree with a verdict is never reviewed again: the verdict
//   holds for every commit with the same code tree key, also after a daemon restart, since both
//   facts are rows.
// - Rounds. A review round starts with a `review` run step. The step's value records the round and
//   the In Review time it waited from, so a session that must wait again keeps its place in line.
//   A round grows no cap: the reviewer has caps of its own per session (0002). A round is open until its verdict is stored; a fresh
//   session after a failed one continues the open round and writes no step, so it adds nothing.
// - Failed rounds. Each blocked verdict appends a `review-failed` step; their count is what the
//   review round cap counts (section 6).

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

import { START_KINDS, type PlaceStart } from "./places";
import { runHeldByPark } from "./park-state";
import { appendRunStep, applyRunEvent, IN_REVIEW_END, type StoredRun } from "./records";
import { REVIEWED_END } from "./rounds";

/** One started review round, from its `review` step. */
export interface ReviewRound {
  readonly round: number;
  /** The In Review time its review waited from. */
  readonly since: number;
  /** When the round started. */
  readonly at: number;
}

interface StepRow {
  value: string;
  at: number;
}

/** A `review` step's value read back; a bare number (a step written before DIPO-219) is its round. */
function roundOf(row: StepRow, index: number): ReviewRound {
  try {
    const value = JSON.parse(row.value) as Partial<ReviewRound> | number;
    if (typeof value === "number") return { round: value, since: row.at, at: row.at };
    return {
      round: typeof value.round === "number" ? value.round : index + 1,
      since: typeof value.since === "number" ? value.since : row.at,
      at: row.at,
    };
  } catch {
    return { round: index + 1, since: row.at, at: row.at };
  }
}

/** The run's review rounds, oldest first. */
export function reviewRounds(office: OfficeHandle, runId: RunId): ReviewRound[] {
  return office
    .all<StepRow>(
      `select value, at from run_steps where office_id = $office_id and run_id = $run
        and kind = 'review' order by step`,
      { run: runId },
    )
    .map(roundOf);
}

/** True when the run stored a verdict for review round `round`. */
function judged(office: OfficeHandle, runId: RunId, round: number): boolean {
  return (
    office.get(
      `select 1 as found from review_verdicts where office_id = $office_id and run_id = $run
        and round = $round and carried_from is null limit 1`,
      { run: runId, round },
    ) !== null
  );
}

/** The run's newest review round while it has no verdict yet; null when none is open. */
export function openReviewRound(office: OfficeHandle, runId: RunId): ReviewRound | null {
  const last = reviewRounds(office, runId).at(-1);
  return last === undefined || judged(office, runId, last.round) ? null : last;
}

/**
 * Inside the caller's transaction: the review round a reviewer session of the run starts in. The
 * open round when there is one (a fresh session after a failed one adds nothing); else a new
 * round, with its `review` step.
 */
export function beginReviewRound(
  office: OfficeHandle,
  run: StoredRun,
  since: number,
  at: number,
): { readonly round: ReviewRound; readonly started: boolean } {
  const open = openReviewRound(office, run.runId);
  if (open !== null) return { round: open, started: false };
  const round: ReviewRound = {
    round: reviewRounds(office, run.runId).length + 1,
    since,
    at,
  };
  appendRunStep(office, run.runId, "review", JSON.stringify({ round: round.round, since }), at);
  return { round, started: true };
}

/** The run's failed review rounds: its `review-failed` steps (0019 section 6). */
export function failedReviewRounds(office: OfficeHandle, runId: RunId): number {
  return (
    office.get<{ n: number }>(
      `select count(*) as n from run_steps where office_id = $office_id and run_id = $run
        and kind = 'review-failed'`,
      { run: runId },
    )?.n ?? 0
  );
}

/**
 * The pending reviews of the office (`PlacesDeps.pending`, 0019 section 12), oldest In Review
 * first: story runs ended at In Review with a live claim and the review loop's caps, whose head is
 * on the remote (or whose office has none, DIPO-315), and whose story has no open park (a story
 * parked while it waits In Review gets no reviewer until it resumes, as the merge slot and fix
 * rounds skip it). Each waits from its In Review time.
 */
export function pendingReviews(office: OfficeHandle): PlaceStart[] {
  const rows = office.all<{ run_id: string; ended_at: number }>(
    `select r.run_id, r.ended_at from runs r
      where r.office_id = $office_id and r.kind = 'story' and r.ended_at is not null
        and r.end_kind = $in_review and r.review_round_cap is not null
        and exists (select 1 from claims c where c.office_id = r.office_id
          and c.run_id = r.run_id and c.released_at is null
          and (c.pushed_at >= r.ended_at or c.no_remote_at >= r.ended_at))
      order by r.ended_at, r.run_id`,
    { in_review: IN_REVIEW_END },
  );
  return rows
    .filter((row) => !runHeldByPark(office, row.run_id))
    .map((row): PlaceStart => ({
      kind: START_KINDS.review,
      runId: row.run_id as RunId,
      since: row.ended_at,
    }));
}

/**
 * Inside the caller's transaction: a run ended at In Review whose head's code tree already has a
 * verdict takes that verdict without a round (section 6): it ends as reviewed, so it is no longer
 * pending. False when the run was not ended at In Review.
 */
export function takeVerdict(office: OfficeHandle, runId: RunId): boolean {
  const relabeled = applyRunEvent(office, runId, {
    kind: "relabel",
    endKind: REVIEWED_END,
    from: IN_REVIEW_END,
  });
  if (relabeled === null) return false;
  // The provisional outcome row says the same (a final row is never rewritten).
  office.run(
    `update run_outcomes set end_kind = $kind,
        outcome = case when outcome = $in_review then $kind else outcome end
      where office_id = $office_id and run_id = $run and final = 0`,
    { run: runId, kind: REVIEWED_END, in_review: IN_REVIEW_END },
  );
  return true;
}
