// The failed hold in force (DIPO-401, 0010), as SQL over `backlog_journal`: a park whose hold the
// Backlog CLI failed to write keeps its story out of pickup until the maintainer acts on it. The
// planning lane's journal (`backlog/lane/journal.ts`) reads it to answer `planningHold`, and
// retention keeps the rows it needs, so one rule serves both. Only retention and `backlog/` read
// the journal (the StoryStore seam, DIPO-379); this file is retention's.

import {
  DISCARD_KIND,
  DROP_KIND,
  HOLD_KIND,
  OPEN_STATES,
  RESUME_KIND,
} from "../story-store/planning";

/** The kinds whose change, journaled and not given up, lifts a failed hold of its story (DIPO-401). */
const LIFTERS = [HOLD_KIND, RESUME_KIND, DROP_KIND, DISCARD_KIND];
/** The states of a change that is journaled and not given up: open, or merged. */
const LIVE = [...OPEN_STATES, "merged"];
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

/**
 * SQL over the `backlog_journal` row `t`: it is a hold the store failed to write that is still in
 * force (DIPO-401). It stays in force until a later change of the same story that lifts it (the park
 * sent again, a resume, a drop or a discard) is journaled and not given up; the maintainer's
 * dismiss withdraws it. A later change that fails, is dropped or is withdrawn lifts nothing. Such
 * a row holds its story from pickup, so retention keeps it.
 */
export function failedHoldInForce(t: string): string {
  return `(${t}.op_kind = '${HOLD_KIND}' and ${t}.state = 'failed' and ${t}.key is not null
    and not exists (select 1 from backlog_journal l where l.office_id = ${t}.office_id
      and l.key = ${t}.key and l.op_id > ${t}.op_id and l.op_kind in (${list(LIFTERS)})
      and l.state in (${list(LIVE)})))`;
}

/**
 * SQL over the `backlog_journal` row `t`: it lifts a failed hold that is still journaled
 * (DIPO-401). Retention keeps it while that hold is, so the hold never comes back in force.
 */
export function liftsJournaledFailedHold(t: string): string {
  return `(${t}.op_kind in (${list(LIFTERS)}) and ${t}.state in (${list(LIVE)})
    and exists (select 1 from backlog_journal f
    where f.office_id = ${t}.office_id and f.key = ${t}.key and f.op_id < ${t}.op_id
      and f.op_kind = '${HOLD_KIND}' and f.state = 'failed'))`;
}
