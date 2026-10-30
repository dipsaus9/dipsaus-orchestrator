// A stuck planning lane on the desk (DIPO-401, 0010): when an operation of the office's lane is
// still not on a pushed branch `LANE_STUCK_MS` after it was journaled (on the engine clock), the
// desk's hand-action group names the lane, how many operations wait since when, and the reason the
// lane's last flush gave (`OfficeLane.stall`). The item is gone once a flush applies and pushes
// them. The desk reads it through `DeskSources.officeItems`.

import type { OfficeHandle } from "../../db/office";
import { deskText, type OfficeHandItem } from "../../views/desk";

import { LANE_STUCK_MS, type LaneStall } from "./lane";

/** The kind of the desk item of a stuck planning lane. */
export const PLANNING_LANE_DESK = "PLANNING LANE";

/** What a lane says when no flush gave a reason since its operations were journaled. */
const NO_FLUSH = "no flush has run since they were journaled";

/**
 * The desk item of the office's planning lane when an operation waits unapplied or unpushed for
 * `LANE_STUCK_MS` or longer at `now`; none otherwise.
 */
export function laneDeskItems(
  office: OfficeHandle,
  stall: LaneStall | null,
  now: number,
): OfficeHandItem[] {
  const row = office.get<{ n: number; since: number | null }>(
    `select count(*) as n, min(created_at) as since from backlog_journal
      where office_id = $office_id and state in ('pending', 'applied', 'committed')`,
  );
  if (row === null || row.n === 0 || row.since === null) return [];
  if (now - row.since < LANE_STUCK_MS) return [];
  const minutes = Math.floor((now - row.since) / 60_000);
  const ops = row.n === 1 ? "1 backlog operation waits" : `${row.n} backlog operations wait`;
  return [
    {
      kind: PLANNING_LANE_DESK,
      detail: `the planning lane is stuck: ${ops} for a backlog PR, the oldest for ${minutes} minutes · ${deskText(stall?.reason ?? NO_FLUSH)}`,
      since: row.since,
      hand: "fix what the reason names; dipo applies the operations at the next backlog change or office load, and the daemon log has a line for each flush that stops",
    },
  ];
}
