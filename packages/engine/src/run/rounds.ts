// The rounds of a run at In Review (0002, 0020): one story run per claim, whose active period ends
// at In Review or at a park. At In Review the run stays open (DIPO-373), in phase review while it
// waits for its review, and in phase merge (or test, `merge/gates.ts`) once its head's verdict is
// in, or build when a blocked verdict waits for its fix round. It is active again on the same run,
// through `reopen`, for a review, a fix round, a conflict hand-off or a park resume. The time it
// stood idle is added to `parked_ms`, and so is a review's own time when the review ends, so the
// developer's minute cap counts only the time the developer worked; the reviewer has its own caps.
// The run keeps its loop and round counts, which are its `run_steps`. A round waits for its place
// (`places.ts`) until its session starts; a park resume decides its own wait (`park-resume.ts`).

import { type Lifecycle, type Phase, type RunId, StoryId } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { deriveStoryView, storyView } from "../views/story";
import { runProgress, withWorkViews, workRefOf } from "../views/work";

import { markPhase } from "./markers";
import { resolvePark } from "./park-records";
import { START_KINDS, type StartKind, waitForPlace } from "./places";
import {
  applyRunEvent,
  findRun,
  openAtInReview,
  reopenRun,
  runPhase,
  type StoredRun,
} from "../records/run-records";

/** The phase a run open at In Review waits in once its head's verdict is in (0009). */
export function phaseAfterVerdict(verdict: "approved" | "blocked"): "merge" | "build" {
  return verdict === "approved" ? "merge" : "build";
}

/** True when the run is open at In Review and waits for its review: its phase is review. */
export function waitsForReview(office: OfficeHandle, run: StoredRun): boolean {
  return openAtInReview(run) && runPhase(office, run.runId) === "review";
}

/**
 * True when the run is open at In Review with its head's verdict in: its phase is past review
 * (merge or test, or build while a blocked verdict waits for its fix round).
 */
export function reviewedInReview(office: OfficeHandle, run: StoredRun): boolean {
  if (!openAtInReview(run)) return false;
  const phase = runPhase(office, run.runId);
  return phase !== null && phase !== "review";
}

/**
 * Inside the caller's transaction: the run enters `phase` at `at` unless it is in it now. Returns
 * the phase marker and the run's `work.phase`, or none.
 */
export function enterPhase(
  office: OfficeHandle,
  runId: RunId,
  phase: Phase,
  at: number,
): NewEntry[] {
  if (runPhase(office, runId) === phase) return [];
  return phaseEntered(office, runId, phase, at);
}

function phaseEntered(office: OfficeHandle, runId: RunId, phase: Phase, at: number): NewEntry[] {
  const markers = markPhase(office, runId, phase, at);
  const work = workRefOf(office, runId);
  const progress = runProgress(office, runId);
  return work === null || progress === null
    ? markers
    : [
        ...markers,
        { type: "work.phase", key: work.key, run: runId, delta: { work, phase, progress } },
      ];
}

/**
 * Inside the caller's transaction: the developer's active period ends at In Review at `at`. The
 * run stays open, in phase review until its review (0020). Returns the phase entries; none when the
 * run was not active.
 */
export function stopAtInReview(office: OfficeHandle, runId: RunId, at: number): NewEntry[] {
  if (applyRunEvent(office, runId, { kind: "in-review", at }) === null) return [];
  return enterPhase(office, runId, "review", at);
}

/** What a run open at In Review reopens for. */
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
   * A review, a fix round or a conflict hand-off of a run open at In Review: it waits for its
   * place from `waitingSince` (`at` by default; a pending review waits from the story's In Review
   * time, oldest In Review first).
   */
  { readonly kind: RoundKind; readonly waitingSince?: number } | ResumeReopen;

/**
 * Inside the caller's transaction: the run `run`, parked or open at In Review, is active again at
 * `at` for `why` (see the file comment). The time since its active period ended is added to
 * `parked_ms`; its provisional outcome row goes until its next end. A run done or dropped stays
 * ended.
 *
 * - A round enters phase `review` (a review) or `build` (a fix round, a hand-off) and waits for
 *   its place. Returns the marker output and the `work.phase` entry, or none when the run was
 *   active already, done or dropped.
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
  const reopened = reopenRun(office, run.runId, at);
  if (resume !== null) {
    const markers = resume.review === true ? markPhase(office, run.runId, "review", at) : [];
    return [...closed, ...resumedState(office, run, resume), ...markers];
  }
  if (!reopened) return [];
  const round = why as Exclude<ReopenFor, ResumeReopen>;
  // A round always writes its phase step, also into the phase the run waited in: a review's step
  // is when its period began (`endReviewPeriod`).
  const entries = phaseEntered(office, run.runId, round.kind === "review" ? "review" : "build", at);
  waitForPlace(office, run.runId, ROUND_STARTS[round.kind], round.waitingSince ?? at);
  return entries;
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
 * When the review period of the active run `runId` began: its newest phase step's time when that
 * phase is review; undefined otherwise.
 */
export function reviewPeriodStart(office: OfficeHandle, runId: RunId): number | undefined {
  const run = findRun(office, runId);
  if (run === null || run.endedAt !== null || run.ending !== null) return undefined;
  const review = office.get<{ value: string; at: number }>(
    `select value, at from run_steps where office_id = $office_id and run_id = $run
      and kind = 'phase' order by step desc limit 1`,
    { run: runId },
  );
  return review?.value === "review" ? review.at : undefined;
}

/**
 * Inside the caller's transaction: the review period of the run `runId` ends at `at` with the
 * head's `verdict`. The run stays open at In Review and enters the phase the verdict leads to
 * (`phaseAfterVerdict`). The time since the run reopened for the review (its newest `review` phase
 * step), the wait for the reviewer place included, is added to `parked_ms` first, so the
 * developer's minute cap and the run's minutes leave the review out. False when the run is not
 * active in a review period.
 */
export function endReviewPeriod(
  office: OfficeHandle,
  runId: RunId,
  at: number,
  verdict: "approved" | "blocked",
): boolean {
  const since = reviewPeriodStart(office, runId);
  if (since === undefined) return false;
  if (applyRunEvent(office, runId, { kind: "in-review", at, reviewSince: since }) === null) {
    return false;
  }
  const entries = enterPhase(office, runId, phaseAfterVerdict(verdict), at);
  appendEntries(office, withWorkViews(office, entries), { at });
  return true;
}
