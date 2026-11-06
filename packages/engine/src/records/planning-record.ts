// The record of a planning session (DIPO-450, 0022): the stories its confirmed proposals filed or
// edited, by the session's run and the proposal's number. Code writes it: an edit when the
// maintainer confirms it, a new story when the planning lane applied it and the story has its id.
// A filing applied again on a newer base can get another id, so its row is replaced, not added.

import type { OfficeHandle } from "../db/office";

/** What a record entry says about its story. */
export type PlanningRecordKind = "filed" | "edited";

export interface PlanningRecordEntry {
  readonly run: string;
  readonly proposal: number;
  readonly kind: PlanningRecordKind;
  readonly story: string;
  readonly at: number;
}

/** Records `entry`, replacing the story of the same run, proposal and kind. Runs in a transaction. */
export function recordPlanningEntry(office: OfficeHandle, entry: PlanningRecordEntry): void {
  office.run(
    `insert into planning_record (office_id, run_id, proposal, kind, story_id, recorded_at)
     values ($office_id, $run, $proposal, $kind, $story, $at)
     on conflict (office_id, run_id, proposal, kind)
       do update set story_id = excluded.story_id, recorded_at = excluded.recorded_at
       where story_id is not excluded.story_id`,
    {
      run: entry.run,
      proposal: entry.proposal,
      kind: entry.kind,
      story: entry.story,
      at: entry.at,
    },
  );
}

/** The record of the session `run`, by proposal and then kind (`filed` first). */
export function planningRecord(office: OfficeHandle, run: string): PlanningRecordEntry[] {
  return office
    .all<{
      proposal: number;
      kind: PlanningRecordKind;
      story_id: string;
      recorded_at: number;
    }>(
      `select proposal, kind, story_id, recorded_at from planning_record
        where office_id = $office_id and run_id = $run
        order by proposal, kind desc`,
      { run },
    )
    .map((row) => ({
      run,
      proposal: row.proposal,
      kind: row.kind,
      story: row.story_id,
      at: row.recorded_at,
    }));
}
