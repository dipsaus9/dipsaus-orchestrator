// Resolving a park (DIPO-344): the one way an open park ends, apart from the run control and
// planning modules that park, so the worktree modules can resolve parks without importing them.

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { closeQuestion, openParkQuestions } from "../hooks/questions";
import { workRefOf } from "../views/work";

import type { StoredRun } from "./records";

/** How a park was resolved (`parks.resolved_how`). */
export type ParkResolution =
  | "resume"
  | "drop"
  | "discard"
  | "reconcile"
  | "done-elsewhere"
  | "override";

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
