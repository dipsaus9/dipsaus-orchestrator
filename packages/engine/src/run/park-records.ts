// Park rows (0007, 0020): the one writer of `parks` (0001). Every insert and update of a park row
// goes through this module, and `test/run/one-writer.test.ts` fails on one anywhere else. It
// imports neither run control nor planning, so the worktree, reconcile and planning modules can
// write parks without importing them. `resolvePark` is the one way an open park ends (DIPO-344).
// Each function runs inside the caller's transaction.

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { closeQuestion, openParkQuestions } from "../questions/questions";
import { workRefOf } from "../views/work";

import type { StoredRun } from "../records/run-records";

/** A park's detail and history row (0007): the reason it was made with, never read as current. */
export interface NewPark {
  readonly key: string;
  readonly story: string;
  /** The run it ended; null for a story parked with no run, or recorded from Backlog.md. */
  readonly runId: string | null;
  readonly reason: string;
  readonly detail: string;
  readonly lastGoodCommit?: string | null;
  readonly at: number;
  /** True for the park a plan limit asked for, which resumes once the limit lifts (0020). */
  readonly resumeOnLift?: boolean;
}

/** Records a new open park with the next park id of the office. */
export function insertPark(office: OfficeHandle, park: NewPark): void {
  office.run(
    `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail,
       last_good_commit, at, resume_on_lift)
     values ($office_id, (select coalesce(max(park_id), 0) + 1 from parks
       where office_id = $office_id), $key, $story, $run, $reason, $detail, $commit, $at,
       $resumeOnLift)`,
    {
      key: park.key,
      story: park.story,
      run: park.runId,
      reason: park.reason,
      detail: park.detail,
      commit: park.lastGoodCommit ?? null,
      at: park.at,
      resumeOnLift: park.resumeOnLift === true ? 1 : 0,
    },
  );
}

/**
 * The open park `parkId` is made again with a new reason, detail and last good commit. It keeps the
 * time it was first made: whether its run stood open at In Review then is read against that time
 * (`parkedFromInReview`, DIPO-373).
 */
export function reparkOpen(
  office: OfficeHandle,
  parkId: number,
  park: Pick<NewPark, "reason" | "detail" | "lastGoodCommit">,
): void {
  office.run(
    `update parks set reason = $reason, detail = $detail, last_good_commit = $commit
      where office_id = $office_id and park_id = $park and resolved_at is null`,
    {
      park: parkId,
      reason: park.reason,
      detail: park.detail,
      commit: park.lastGoodCommit ?? null,
    },
  );
}

/** The open park `parkId` no longer resumes by itself when the plan limit lifts (0020). */
export function keepParkedOnLift(office: OfficeHandle, parkId: number): void {
  office.run(
    `update parks set resume_on_lift = 0
      where office_id = $office_id and park_id = $park and resolved_at is null`,
    { park: parkId },
  );
}

/** How a park was resolved (`parks.resolved_how`). */
export type ParkResolution =
  | "resume"
  | "drop"
  | "discard"
  | "reconcile"
  | "done-elsewhere"
  | "override";

/** The run the park `parkId` was made on and when it was first made, or null. */
export function parkedRunOf(
  office: OfficeHandle,
  parkId: number,
): { readonly runId: string; readonly at: number } | null {
  const row = office.get<{ run_id: string | null; at: number }>(
    "select run_id, at from parks where office_id = $office_id and park_id = $park",
    { park: parkId },
  );
  return row === null || row.run_id === null ? null : { runId: row.run_id, at: row.at };
}

/**
 * Inside the caller's transaction: the open park `parkId` is resolved `how` at `at`, with the
 * maintainer's note when one came with it (`parks.resolved_note`), and every question it still
 * holds open is closed `expired`, each with its `question.closed` (DIPO-344): the one way a park
 * is resolved, so no client keeps showing a question nothing waits on. Close a question as
 * answered before calling it. Returns nothing when the park was resolved already.
 */
export function resolvePark(
  office: OfficeHandle,
  parkId: number,
  how: ParkResolution,
  at: number,
  note: string | null = null,
): NewEntry[] {
  const changed = office.run(
    `update parks set resolved_at = $at, resolved_how = $how, resolved_note = $note
     where office_id = $office_id and park_id = $park and resolved_at is null`,
    { at, how, park: parkId, note },
  ).changes;
  if (changed === 0) return [];
  const entries: NewEntry[] = [];
  for (const question of openParkQuestions(office, parkId)) {
    if (!closeQuestion(office, question.questionId, "expired", at)) continue;
    const run = question.runId as StoredRun["runId"];
    const work = workRefOf(office, run);
    entries.push({
      type: "question.closed",
      ...(work === null ? {} : { key: work.key }),
      run,
      delta: { question: question.questionId },
    });
  }
  return entries;
}

/** The ids of every open park of a story, of its run `runId` only when given, oldest first. */
export function openParkIds(office: OfficeHandle, key: string, runId?: string): number[] {
  return office
    .all<{ park_id: number }>(
      `select park_id from parks where office_id = $office_id and key = $key
        and resolved_at is null and ($run is null or run_id = $run) order by park_id`,
      { key, run: runId ?? null },
    )
    .map((row) => row.park_id);
}

/**
 * Retention (0007): deletes at most `limit` parks resolved before `cutoff`, inside the caller's
 * transaction; returns how many it deleted. An open park is the history of a story still parked.
 */
export function deleteParksResolvedBefore(
  office: OfficeHandle,
  cutoff: number,
  limit: number,
): number {
  return office.run(
    `delete from parks where rowid in (select rowid from parks
       where office_id = $office_id and resolved_at < $cutoff limit $limit)`,
    { cutoff, limit },
  ).changes;
}
