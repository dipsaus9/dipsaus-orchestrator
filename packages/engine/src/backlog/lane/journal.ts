// The lane-b journal (0010 section 2, 0007 section 4): every planning operation is a row in
// `backlog_journal` before any Backlog CLI call, and its state records how far it got. Rows are
// read and written through the office handle, so every statement binds the office. Callers that
// change a row run inside `office.immediate`.

import { FieldBlockPark, type StoryKey } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../../db/office";
import {
  DROP_KIND,
  EditTarget,
  HOLD_KIND,
  type JournalState,
  OPEN_STATES,
  PENDING_LANE_NOTICE,
  type PlannedPark,
} from "../../story-store/planning";

export { OPEN_STATES, PENDING_LANE_NOTICE };
export type { JournalState };

/** A planning operation as its caller hands it to the lane. */
export interface LaneOp {
  /** A kind the lane knows (`edit`, or one a later story registers); also the commit's verb. */
  readonly kind: string;
  /** The story the operation changes; absent for an office-wide one such as a config change. */
  readonly key?: StoryKey;
  /** What the commit message names: the story id, or a word for an office-wide operation. */
  readonly subject: string;
  /** The target state, as JSON; re-applying it is always safe (0010 section 2). */
  readonly target: unknown;
  /**
   * True when the caller releases the story's live claim right after journaling (`story.drop`,
   * 0010 section 2a: journal first, then the release steps): the live-claim check is skipped.
   */
  readonly releasesClaim?: boolean;
}

export interface JournalEntry {
  readonly opId: number;
  readonly key: StoryKey | null;
  readonly subject: string;
  readonly kind: string;
  readonly target: unknown;
  readonly branch: string | null;
  readonly state: JournalState;
  readonly commit: string | null;
  readonly prRef: string | null;
  readonly notice: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
}

interface JournalRow {
  op_id: number;
  key: string | null;
  subject: string;
  op_kind: string;
  target: string;
  branch: string | null;
  state: JournalState;
  commit_sha: string | null;
  pr_ref: string | null;
  notice: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

const COLUMNS = `op_id, key, subject, op_kind, target, branch, state, commit_sha, pr_ref, notice,
  created_at, updated_at, closed_at`;

const OPEN_SQL = OPEN_STATES.map((state) => `'${state}'`).join(", ");

function toEntry(row: JournalRow): JournalEntry {
  return {
    opId: row.op_id,
    key: row.key as StoryKey | null,
    subject: row.subject,
    kind: row.op_kind,
    target: JSON.parse(row.target) as unknown,
    branch: row.branch,
    state: row.state,
    commit: row.commit_sha,
    prRef: row.pr_ref,
    notice: row.notice,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

/** Journals `op` as `pending` with the next op id. Runs inside the caller's transaction. */
export function insertEntry(office: OfficeHandle, op: LaneOp, now: number): JournalEntry {
  const next =
    office.get<{ n: number }>(
      "select coalesce(max(op_id), 0) + 1 as n from backlog_journal where office_id = $office_id",
    )?.n ?? 1;
  office.run(
    `insert into backlog_journal (office_id, op_id, key, subject, op_kind, target, state,
       created_at, updated_at)
     values ($office_id, $op, $key, $subject, $kind, $target, 'pending', $now, $now)`,
    {
      op: next,
      key: op.key ?? null,
      subject: op.subject,
      kind: op.kind,
      target: JSON.stringify(op.target ?? null),
      now,
    },
  );
  const entry = findEntry(office, next);
  if (entry === null) throw new Error(`journal entry ${next} vanished after its insert`);
  return entry;
}

/**
 * The target of an entry adopted from an open backlog PR after the database was lost (DIPO-80):
 * the commit is on the branch, but its target state was journaled in the lost database, so the
 * lane cannot apply it again.
 */
export const ADOPTED_TARGET = { adoptedFromBranch: true } as const;

/** True when `target` is `ADOPTED_TARGET`. */
export function isAdoptedTarget(target: unknown): boolean {
  return (
    typeof target === "object" &&
    target !== null &&
    (target as { adoptedFromBranch?: unknown }).adoptedFromBranch === true
  );
}

/** A lane commit found on an adopted backlog branch, with the op id its trailer names. */
export interface AdoptedOp {
  readonly opId: number;
  readonly kind: string;
  readonly subject: string;
  readonly key: StoryKey | null;
  readonly commit: string;
  /** `pushed` when the commit is in the PR's head on the host, `committed` when only local. */
  readonly state: "committed" | "pushed";
}

/** The op ids among `ids` the journal already has, in any state. */
export function takenOpIds(office: OfficeHandle, ids: readonly number[]): number[] {
  return ids.filter(
    (op) =>
      office.get<{ op_id: number }>(
        "select op_id from backlog_journal where office_id = $office_id and op_id = $op",
        { op },
      ) !== null,
  );
}

/**
 * Journals a commit of an adopted backlog branch under the op id its trailer names, so later
 * operations get higher ids than every commit on the branch and the lane's trailer recovery never
 * mistakes an old commit for a new operation. Runs inside the caller's transaction.
 */
export function insertAdoptedEntry(
  office: OfficeHandle,
  op: AdoptedOp,
  branch: string,
  prRef: string,
  now: number,
): void {
  office.run(
    `insert into backlog_journal (office_id, op_id, key, subject, op_kind, target, branch, state,
       commit_sha, pr_ref, notice, created_at, updated_at)
     values ($office_id, $op, $key, $subject, $kind, $target, $branch, $state, $commit, $pr,
       $notice, $now, $now)`,
    {
      op: op.opId,
      key: op.key,
      subject: op.subject,
      kind: op.kind,
      target: JSON.stringify(ADOPTED_TARGET),
      branch,
      state: op.state,
      commit: op.commit,
      pr: prRef,
      notice: `adopted from ${branch} after the state database was lost`,
      now,
    },
  );
}

export function findEntry(office: OfficeHandle, opId: number): JournalEntry | null {
  const row = office.get<JournalRow>(
    `select ${COLUMNS} from backlog_journal where office_id = $office_id and op_id = $op`,
    { op: opId },
  );
  return row === null ? null : toEntry(row);
}

/** Every open entry, in journal order. */
export function openEntries(office: OfficeHandle): JournalEntry[] {
  return office
    .all<JournalRow>(
      `select ${COLUMNS} from backlog_journal
       where office_id = $office_id and state in (${OPEN_SQL}) order by op_id`,
    )
    .map(toEntry);
}

/** Every entry, in journal order. */
export function allEntries(office: OfficeHandle): JournalEntry[] {
  return office
    .all<JournalRow>(
      `select ${COLUMNS} from backlog_journal where office_id = $office_id order by op_id`,
    )
    .map(toEntry);
}

export interface EntryChange {
  readonly state: JournalState;
  /** Leaves the branch as it is when absent; null clears it. */
  readonly branch?: string | null;
  readonly commit?: string | null;
  readonly prRef?: string | null;
  readonly notice?: string | null;
}

/** Moves an entry to a new state. Runs inside the caller's transaction. */
export function updateEntry(
  office: OfficeHandle,
  opId: number,
  change: EntryChange,
  now: number,
): void {
  const closed = !OPEN_STATES.includes(change.state);
  office.run(
    `update backlog_journal set
       state = $state,
       branch = case when $set_branch then $branch else branch end,
       commit_sha = case when $set_commit then $commit else commit_sha end,
       pr_ref = case when $set_pr then $pr else pr_ref end,
       notice = case when $set_notice then $notice else notice end,
       updated_at = $now,
       closed_at = case when $closed then $now else null end
     where office_id = $office_id and op_id = $op`,
    {
      op: opId,
      state: change.state,
      set_branch: change.branch !== undefined ? 1 : 0,
      branch: change.branch ?? null,
      set_commit: change.commit !== undefined ? 1 : 0,
      commit: change.commit ?? null,
      set_pr: change.prRef !== undefined ? 1 : 0,
      pr: change.prRef ?? null,
      set_notice: change.notice !== undefined ? 1 : 0,
      notice: change.notice ?? null,
      closed: closed ? 1 : 0,
      now,
    },
  );
}

/**
 * Records the backlog PR of an engine branch on its open entries (DIPO-35 stores it after opening
 * the PR). Runs inside the caller's transaction; returns how many entries took it.
 */
export function recordPrRef(
  office: OfficeHandle,
  branch: string,
  prRef: string,
  now: number,
): number {
  return office.run(
    `update backlog_journal set pr_ref = $pr, updated_at = $now
     where office_id = $office_id and branch = $branch and state in (${OPEN_SQL})`,
    { branch, pr: prRef, now },
  ).changes;
}

/** Why a story is skipped while a lane-b operation for it is open. */
export interface PendingLaneOp {
  readonly reason: "notRunnable";
  readonly notice: typeof PENDING_LANE_NOTICE;
  /** The open operations, oldest first. */
  readonly ops: readonly number[];
}

/**
 * Reports a story with an open lane-b operation, from journaling until the entry is merged,
 * dropped or withdrawn (0010 section 2: a pending lane-b operation always wins over pickup).
 * `work.run` and the pickup re-check (DIPO-48) skip such a story as `notRunnable`.
 */
export function pendingLaneOp(office: OfficeHandle, key: StoryKey): PendingLaneOp | null {
  const rows = office.all<{ op_id: number }>(
    `select op_id from backlog_journal
     where office_id = $office_id and key = $key and state in (${OPEN_SQL}) order by op_id`,
    { key },
  );
  if (rows.length === 0) return null;
  return { reason: "notRunnable", notice: PENDING_LANE_NOTICE, ops: rows.map((row) => row.op_id) };
}

/**
 * Pure: the park a journaled change of `kind` with `target` writes: `undefined` when it sets
 * neither the status nor the park, else its park record (null when it lifts, drops or moves the
 * story to a status other than Parked).
 */
export function parkOfTarget(kind: string, target: unknown): PlannedPark | null | undefined {
  if (kind === DROP_KIND) return null;
  const parsed = EditTarget.safeParse(target);
  if (!parsed.success) return undefined;
  const { status, fields, unset } = parsed.data;
  const park = fields?.["park"];
  if (status === undefined && park === undefined && !(unset ?? []).includes("park")) {
    return undefined;
  }
  if (status !== undefined && status !== "Parked") return null;
  if (park === undefined) return null;
  const record = FieldBlockPark.safeParse(park);
  return record.success ? record.data : null;
}

/**
 * The park an open operation of the story `key` writes, newest first (`StoryStore.plannedPark`):
 * `undefined` when no open operation sets its status or park, else its park record (null when it
 * lifts, drops or moves the story to a status other than Parked).
 */
export function journaledPark(
  office: OfficeHandle,
  key: StoryKey | string,
): PlannedPark | null | undefined {
  const rows = office.all<{ op_kind: string; target: string }>(
    `select op_kind, target from backlog_journal
      where office_id = $office_id and key = $key and state in (${OPEN_SQL})
      order by op_id desc`,
    { key },
  );
  for (const row of rows) {
    const park = parkOfTarget(row.op_kind, JSON.parse(row.target));
    if (park !== undefined) return park;
  }
  return undefined;
}

/** A hold whose write the Backlog CLI failed on, still the newest operation of its story (DIPO-401). */
export interface FailedHold {
  readonly opId: number;
  readonly key: StoryKey;
  readonly subject: string;
  /** The status the hold parked the story from. */
  readonly from: string | null;
  /** The notice the lane closed it with. */
  readonly notice: string | null;
  /** When it was closed. */
  readonly at: number;
}

function failedHoldOf(row: JournalRow): FailedHold {
  const parsed = EditTarget.safeParse(JSON.parse(row.target));
  const park = parsed.success ? FieldBlockPark.safeParse(parsed.data.fields?.["park"]) : null;
  return {
    opId: row.op_id,
    key: row.key as StoryKey,
    subject: row.subject,
    from: park?.success === true ? park.data.from : null,
    notice: row.notice,
    at: row.closed_at ?? row.updated_at,
  };
}

const NEWEST_PER_STORY = `select ${COLUMNS} from backlog_journal j
  where office_id = $office_id and key is not null and op_kind = $hold and state = 'failed'
    and op_id = (select max(op_id) from backlog_journal k
      where k.office_id = j.office_id and k.key = j.key)`;

/**
 * The stories whose newest operation is a hold the Backlog CLI failed on (DIPO-401): the park the
 * maintainer asked for was never written, so the story stays out of pickup (fail closed) until a
 * newer operation of the story (the park sent again, or its resume withdrawing this one) follows.
 */
export function failedHolds(office: OfficeHandle): FailedHold[] {
  return office
    .all<JournalRow>(`${NEWEST_PER_STORY} order by op_id`, { hold: HOLD_KIND })
    .map(failedHoldOf);
}

/** `failedHolds` of the story `key`, or null. */
export function failedHold(office: OfficeHandle, key: StoryKey | string): FailedHold | null {
  const row = office.get<JournalRow>(`${NEWEST_PER_STORY} and key = $key`, {
    hold: HOLD_KIND,
    key,
  });
  return row === null ? null : failedHoldOf(row);
}
