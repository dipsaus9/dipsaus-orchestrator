// The run across review rounds (0019 section 13, DIPO-142): one story run per claim, whose active
// period ends at In Review (DIPO-49) and reopens on the same run for a review round, a fix round or
// a conflict hand-off, as a park resume reopens it (`reopenParkedRun`). The time it stood ended is
// added to `parked_ms`, and so is a review's own time when the review ends, so the developer's
// minute cap counts only the time the developer worked; the reviewer has its own caps. The run
// keeps its loop and round counts, which are its `run_steps`. A reopened run waits for its place
// (`places.ts`) until its session starts.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { runProgress, workRefOf } from "../views/work";

import { endRunMarked, markPhase } from "./markers";
import { START_KINDS, type StartKind, waitForPlace } from "./places";
import { findRun, reopenRun, type StoredRun } from "./records";

/** What a run ended at In Review reopens for. */
export type RoundKind = "review" | "fix" | "conflict";

/** The end kind of a review period: the run waits for the verdict, CI or the merge gate. */
export const REVIEWED_END = "reviewed";

const ROUND_STARTS: Readonly<Record<RoundKind, StartKind>> = {
  review: START_KINDS.review,
  fix: START_KINDS.fix,
  conflict: START_KINDS.conflict,
};

/**
 * Inside the caller's transaction: reopens the run `run`, ended at In Review, for `kind` at `at`,
 * and puts it in line for its place: a review waits for the reviewer place, a fix round or a
 * conflict hand-off for the worker place. A review enters phase `review`, a fix round or a
 * hand-off phase `build`. Returns the marker output and `work.phase` entries for the caller to
 * append; none when the run was not ended (or its story is Done).
 */
export function reopenForRound(
  office: OfficeHandle,
  run: StoredRun,
  kind: RoundKind,
  at: number,
): NewEntry[] {
  if (!reopenRun(office, run.runId, at)) return [];
  const phase = kind === "review" ? "review" : "build";
  const markers = markPhase(office, run.runId, phase, at);
  waitForPlace(office, run.runId, ROUND_STARTS[kind], at);
  const work = workRefOf(office, run.runId);
  const progress = runProgress(office, run.runId);
  return work === null || progress === null
    ? markers
    : [
        ...markers,
        { type: "work.phase", key: work.key, run: run.runId, delta: { work, phase, progress } },
      ];
}

/**
 * Inside the caller's transaction: the review period of the run `runId` ends at `at` with `kind`.
 * The time since the run reopened for the review (its newest `review` phase step), the wait for
 * the reviewer place included, is added to `parked_ms` first, so the developer's minute cap and
 * the run's minutes leave the review out. False when the run is not open in a review period.
 */
export function endReviewPeriod(
  office: OfficeHandle,
  runId: RunId,
  at: number,
  kind: string = REVIEWED_END,
): boolean {
  const run = findRun(office, runId);
  if (run === null || run.endedAt !== null) return false;
  const review = office.get<{ value: string; at: number }>(
    `select value, at from run_steps where office_id = $office_id and run_id = $run
      and kind = 'phase' order by step desc limit 1`,
    { run: runId },
  );
  if (review?.value !== "review") return false;
  office.run(
    `update runs set parked_ms = parked_ms + $review where office_id = $office_id and run_id = $run`,
    { run: runId, review: Math.max(0, at - review.at) },
  );
  return endRunMarked(office, runId, at, kind);
}
