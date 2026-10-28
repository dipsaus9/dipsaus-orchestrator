// The one reopen of a run (0002, 0020): one story run per claim, whose active period ends at In
// Review or at a park and opens again on the same run, through `reopen`, for a review, a fix round,
// a conflict hand-off or a park resume. The time it stood ended is added to `parked_ms`, and so is
// a review's own time when the review ends, so the developer's minute cap counts only the time the
// developer worked; the reviewer has its own caps. The run keeps its loop and round counts, which
// are its `run_steps`. A round waits for its place (`places.ts`) until its session starts; a park
// resume decides its own wait (`park-resume.ts`).

import { type Lifecycle, type RunId, StoryId } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { deriveStoryView, storyView } from "../views/story";
import { runProgress, workRefOf } from "../views/work";

import { endRunMarked, markPhase } from "./markers";
import { resolvePark } from "./park-resolve";
import { START_KINDS, type StartKind, waitForPlace } from "./places";
import { DONE_END, findRun, REVIEWED_END, type StoredRun } from "./records";

export { REVIEWED_END };

/** What a run ended at In Review reopens for. */
export type RoundKind = "review" | "fix" | "conflict";

const ROUND_STARTS: Readonly<Record<RoundKind, StartKind>> = {
  review: START_KINDS.review,
  fix: START_KINDS.fix,
  conflict: START_KINDS.conflict,
};

/** A park resume (0020). */
export interface ResumeReopen {
  readonly kind: "resume";
  readonly park: { readonly parkId: number; readonly reason: string; readonly detail: string };
  /** The story's state before the park, which it gets back. */
  readonly to: Lifecycle;
  /** The maintainer's note, kept on the park row. */
  readonly note: string | null;
  /** True when the resume starts a fresh review of the same head. */
  readonly review?: boolean;
}

/** Why an ended run opens again. */
export type ReopenFor =
  /**
   * A review, a fix round or a conflict hand-off of a run ended at In Review: it waits for its
   * place from `waitingSince` (`at` by default; a pending review waits from the story's In Review
   * time, oldest In Review first).
   */
  { readonly kind: RoundKind; readonly waitingSince?: number } | ResumeReopen;

/**
 * Inside the caller's transaction: the ended run `run` opens again at `at` for `why` (see the file
 * comment). Its end is cleared and the time since it ended added to `parked_ms`; its provisional
 * outcome row goes until its next end. A run whose story is Done stays ended.
 *
 * - A round enters phase `review` (a review) or `build` (a fix round, a hand-off) and waits for
 *   its place. Returns the marker output and the `work.phase` entry, or none when the run was not
 *   ended (or its story is Done).
 * - A resume resolves the park first, so the resumed session continues the same run with what
 *   remains of its budget (0020), and the stream drift count starts again, so one stray line does
 *   not park it at once (DIPO-315). A fresh review enters phase `review`. Returns the park's
 *   `question.closed` entries, the `story.state` entry back to `to` and the review's markers.
 */
export function reopen(
  office: OfficeHandle,
  run: StoredRun,
  at: number,
  why: ReopenFor,
): NewEntry[] {
  const resume = why.kind === "resume" ? why : null;
  const closed =
    resume === null ? [] : resolvePark(office, resume.park.parkId, "resume", at, resume.note);
  if (resume !== null) {
    office.run(
      `update ingest_cursors set drift_lines = 0 where office_id = $office_id and run_id = $run`,
      { run: run.runId },
    );
  }
  const reopened =
    office.run(
      `update runs set parked_ms = parked_ms + max(0, $at - coalesce(ended_at, $at)),
         ended_at = null, end_kind = null
       where office_id = $office_id and run_id = $run and ended_at is not null
         and end_kind is not $done`,
      { run: run.runId, at, done: DONE_END },
    ).changes > 0;
  if (reopened) {
    office.run(
      "delete from run_outcomes where office_id = $office_id and run_id = $run and final = 0",
      { run: run.runId },
    );
  }
  if (resume !== null) {
    const markers = resume.review === true ? markPhase(office, run.runId, "review", at) : [];
    return [...closed, ...resumedState(office, run, resume), ...markers];
  }
  if (!reopened) return [];
  const round = why as Exclude<ReopenFor, ResumeReopen>;
  const phase = round.kind === "review" ? "review" : "build";
  const markers = markPhase(office, run.runId, phase, at);
  waitForPlace(office, run.runId, ROUND_STARTS[round.kind], round.waitingSince ?? at);
  const work = workRefOf(office, run.runId);
  const progress = runProgress(office, run.runId);
  return work === null || progress === null
    ? markers
    : [
        ...markers,
        { type: "work.phase", key: work.key, run: run.runId, delta: { work, phase, progress } },
      ];
}

/** The `story.state` entry of a resumed park, back to its state before the park. */
function resumedState(office: OfficeHandle, run: StoredRun, resume: ResumeReopen): NewEntry[] {
  const key = run.key;
  const story = run.story;
  if (key === null || story === null) return [];
  const current = storyView(office, key);
  const view = deriveStoryView({
    key,
    story: current?.story ?? StoryId.parse(story),
    title: current?.title ?? "",
    lifecycle: resume.to,
    ...(current?.tier === undefined ? {} : { tier: current.tier }),
  });
  return [
    {
      type: "story.state",
      key,
      delta: {
        story,
        key,
        from: "Parked",
        to: resume.to,
        detail: [`resumed from ${resume.park.reason}: ${resume.park.detail}`],
      },
      view,
    },
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
