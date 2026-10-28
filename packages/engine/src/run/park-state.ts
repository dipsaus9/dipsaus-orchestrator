// A story's current park (DIPO-360; 0001 "Data ownership", 0007, 0010): the one way the engine asks
// whether a story is parked, why and from where. Backlog.md owns the status and the park record
// (the `dipo` field block's `park: {reason, from, note}`); the engine reads them as the story
// index last read them (`backlog_mirror`, refreshed after every park and lift commit, and set from
// the park's read-back in the park's own transaction), or as an open planning-lane operation
// writes them before its backlog PR merges (0010: a pending operation wins). The `parks` table is
// run detail and history only: its open row gives the park's id, run, detail, last good commit and
// time, and its `reason` column is the reason the park was made with, never read here.
//
// A story is parked only while Backlog.md says so: status Parked with a park record. An open
// `parks` row without that record (a park never written to Backlog.md) is not a park; reconcile
// closes it with a notice. A park record with no open row is a park without run detail until
// reconcile records it.

import {
  FieldBlockPark,
  type Lifecycle,
  type ParkReason,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import { OPEN_STATES } from "../backlog/lane/journal";
import { DROP_KIND, EditTarget } from "../backlog/lane/ops";
import type { OfficeHandle } from "../db/office";

/** The park record Backlog.md holds for a story. */
export interface BacklogPark {
  readonly reason: ParkReason;
  readonly from: Lifecycle;
  readonly note: string;
}

/** A story's current park: Backlog.md's record with the run detail of its open `parks` row. */
export interface OpenPark {
  readonly parkId: number;
  /** From Backlog.md. */
  readonly reason: ParkReason;
  /** From Backlog.md: the lifecycle the story returns to on resume. */
  readonly from: Lifecycle;
  readonly detail: string;
  readonly runId: string | null;
  readonly lastGoodCommit: string | null;
  readonly at: number;
}

const OPEN_SQL = OPEN_STATES.map((state) => `'${state}'`).join(", ");

function parkOf(json: unknown): BacklogPark | null {
  const parsed = FieldBlockPark.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * The park an open planning-lane operation writes, newest first: `undefined` when no open
 * operation sets the story's status or park, else its park record (null when it lifts, drops or
 * moves the story to a status other than Parked).
 */
function laneParkOf(office: OfficeHandle, key: string): BacklogPark | null | undefined {
  const rows = office.all<{ op_kind: string; target: string }>(
    `select op_kind, target from backlog_journal
      where office_id = $office_id and key = $key and state in (${OPEN_SQL})
      order by op_id desc`,
    { key },
  );
  for (const row of rows) {
    if (row.op_kind === DROP_KIND) return null;
    const target = EditTarget.safeParse(JSON.parse(row.target));
    if (!target.success) continue;
    const { status, fields, unset } = target.data;
    const park = fields?.["park"];
    if (status === undefined && park === undefined && !(unset ?? []).includes("park")) continue;
    if (status !== undefined && status !== "Parked") return null;
    return park === undefined ? null : parkOf(park);
  }
  return undefined;
}

/**
 * The park record Backlog.md holds for the story `key` now, or null when it is not Parked there:
 * an open planning-lane operation's record first, else the story index's read (status Parked with
 * a park record).
 */
export function backlogPark(office: OfficeHandle, key: StoryKey | string): BacklogPark | null {
  const lane = laneParkOf(office, key);
  if (lane !== undefined) return lane;
  const row = office.get<{ kind: string; status: string; park: string | null }>(
    `select kind, status, park from backlog_mirror where office_id = $office_id and key = $key`,
    { key },
  );
  if (row === null || row.kind !== "task" || row.status !== "Parked" || row.park === null) {
    return null;
  }
  return parkOf(JSON.parse(row.park));
}

/** The newest open `parks` row of the story: run detail only. */
function openParkRow(office: OfficeHandle, key: string): Omit<OpenPark, "reason" | "from"> | null {
  const row = office.get<{
    park_id: number;
    detail: string;
    run_id: string | null;
    last_good_commit: string | null;
    at: number;
  }>(
    `select park_id, detail, run_id, last_good_commit, at from parks
     where office_id = $office_id and key = $key and resolved_at is null
     order by park_id desc limit 1`,
    { key },
  );
  return row === null
    ? null
    : {
        parkId: row.park_id,
        detail: row.detail,
        runId: row.run_id,
        lastGoodCommit: row.last_good_commit,
        at: row.at,
      };
}

/**
 * The story's current park, or null when it is not parked: Backlog.md's park record (its reason
 * and origin) with the run detail of the open `parks` row. Null when either is missing; see the
 * file comment.
 */
export function openPark(office: OfficeHandle, key: StoryKey | string): OpenPark | null {
  const park = backlogPark(office, key);
  if (park === null) return null;
  const row = openParkRow(office, key);
  return row === null ? null : { ...row, reason: park.reason, from: park.from };
}

/**
 * Inside the park's transaction (DIPO-360): the story index's read of the story set to what the
 * park write read back on the story branch (status Parked and the park record), so every reader
 * sees the park at once; the refresh after the commit reads the whole story again. A story the
 * index never read keeps no row.
 */
export function mirrorPark(
  office: OfficeHandle,
  key: StoryKey | string,
  park: BacklogPark,
  at: number,
): void {
  const json = JSON.stringify({ reason: park.reason, from: park.from, note: park.note });
  office.run(
    `update backlog_mirror set status = 'Parked',
       park_since = case when park is $park then park_since else $at end, park = $park
     where office_id = $office_id and key = $key and kind = 'task'`,
    { key, park: json, at },
  );
}

/**
 * Inside the lift's transaction (DIPO-360): the story index's read of the story set to what the
 * lift wrote on the story branch (status `to`, no park record).
 */
export function mirrorUnpark(office: OfficeHandle, key: StoryKey | string, to: Lifecycle): void {
  office.run(
    `update backlog_mirror set status = $to, park = null, park_since = null
     where office_id = $office_id and key = $key and kind = 'task'`,
    { key, to },
  );
}

/** True when the story of the run `runId` is parked (`openPark`); false for a run with no story. */
export function parkedRun(office: OfficeHandle, runId: string): boolean {
  const row = office.get<{ key: string | null }>(
    "select key from runs where office_id = $office_id and run_id = $run",
    { run: runId },
  );
  return row?.key != null && openPark(office, row.key) !== null;
}

/**
 * The park `parkId` as a resume captured it, while its `parks` row is still unresolved (DIPO-360):
 * run detail, for a resume's idempotency once its lift may already be on the branch, so not the
 * current state. The reason is the one the resume captured from Backlog.md before the lift.
 */
export function unresolvedPark(
  office: OfficeHandle,
  key: string,
  parkId: number,
  captured: { readonly reason: string; readonly from: Lifecycle },
): OpenPark | null {
  const row = office.get<{
    detail: string;
    run_id: string | null;
    last_good_commit: string | null;
    at: number;
  }>(
    `select detail, run_id, last_good_commit, at from parks
      where office_id = $office_id and park_id = $park and key = $key and resolved_at is null`,
    { park: parkId, key },
  );
  return row === null
    ? null
    : {
        parkId,
        reason: captured.reason as ParkReason,
        from: captured.from,
        detail: row.detail,
        runId: row.run_id,
        lastGoodCommit: row.last_good_commit,
        at: row.at,
      };
}

/**
 * The fail-closed guard of the work that follows a story's run (DIPO-360): true while Backlog.md
 * holds the story as parked, and while any `parks` row of the story is unresolved, also one whose
 * write to Backlog.md failed, until reconcile or a resume resolves it. The merge slot, the
 * reviewer, fix rounds and the Done teardown never start on a story the engine reported as Parked.
 */
export function heldByPark(office: OfficeHandle, key: StoryKey | string): boolean {
  if (backlogPark(office, key) !== null) return true;
  return (
    office.get(
      `select 1 as found from parks where office_id = $office_id and key = $key
        and resolved_at is null limit 1`,
      { key },
    ) !== null
  );
}

/** `heldByPark` of the story of the run `runId`; false for a run with no story. */
export function runHeldByPark(office: OfficeHandle, runId: string): boolean {
  const row = office.get<{ key: string | null }>(
    "select key from runs where office_id = $office_id and run_id = $run",
    { run: runId },
  );
  return row?.key != null && heldByPark(office, row.key);
}

/**
 * Open `parks` rows of stories Backlog.md does not hold as parked: parks whose write to Backlog.md
 * failed (`park.notWritten`), which hold the story's work until reconcile or a resume resolves them.
 * Newest row per story.
 */
export function unwrittenParks(office: OfficeHandle): {
  readonly key: string;
  readonly story: string;
  readonly detail: string;
  readonly at: number;
}[] {
  const rows = office.all<{ key: string; story_id: string; detail: string; at: number }>(
    `select key, story_id, detail, at from parks p
      where office_id = $office_id and resolved_at is null
        and park_id = (select max(park_id) from parks q where q.office_id = p.office_id
          and q.key = p.key and q.resolved_at is null)
      order by at, park_id`,
  );
  return rows
    .filter((row) => backlogPark(office, row.key) === null)
    .map((row) => ({ key: row.key, story: row.story_id, detail: row.detail, at: row.at }));
}
