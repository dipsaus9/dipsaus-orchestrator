// The open feedback of a run's handoff (0020 section 6, DIPO-154): the run's feedback items that a
// later green verify or approval has not answered yet, read with their text from 0019's
// `feedback_items` (DIPO-148). A new session of the run lists them in its handoff block, so a fix
// round, a CI failure or a conflict the previous session left open reaches the next one.
//
// An item counts as answered by a fact stored after it was:
// - a green verify of the run (`verify_results`, passed), the local verify of a Mac run;
// - an approving review verdict of the run (`review_verdicts`, approved), or a maintainer override
//   past a blocked one.
// A box run's verify is CI (0021 amendment of 2026-10-22): green CI on a later head is not stored
// (the story PR poll keeps it in memory), so a box run's CI item stays open until a verdict
// approves a later head.
//
// `feedback_items` arrives with DIPO-148's migration. Until it exists this reads no items, so a
// database without it lists no open feedback instead of failing the handoff.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

/** One stored feedback item as the handoff reads it. */
export interface StoredFeedback {
  /** `verify`, `ci`, `review`, `conflict` or `reject` (0019 section 8). */
  readonly source: string;
  /** The pushed head the item was found on. */
  readonly head: string;
  /** The rendered item text, at most 3,000 characters. */
  readonly text: string;
  readonly createdAt: number;
}

/** True when the office database has the table `name`. */
export function hasTable(office: OfficeHandle, name: string): boolean {
  // `$office_id` only satisfies the office handle's binding rule; the schema is the connection's.
  return (
    office.get<{ name: string }>(
      `select name from sqlite_master where type = 'table' and name = $name
        and $office_id is not null`,
      { name },
    ) !== null
  );
}

/** The run's stored feedback items, oldest first; none before `feedback_items` exists. */
export function storedFeedbackOf(office: OfficeHandle, runId: RunId | string): StoredFeedback[] {
  if (!hasTable(office, "feedback_items")) return [];
  return office
    .all<{ source: string; head_sha: string; text: string; created_at: number }>(
      `select source, head_sha, text, created_at from feedback_items
        where office_id = $office_id and run_id = $run order by item_id`,
      { run: runId },
    )
    .map((row) => ({
      source: row.source,
      head: row.head_sha,
      text: row.text,
      createdAt: row.created_at,
    }));
}

/** When the run's newest green verify or approval was stored; null when it has none. */
export function lastAnsweredAt(office: OfficeHandle, runId: RunId | string): number | null {
  const verify = office.get<{ at: number | null }>(
    `select max(at) as at from verify_results
      where office_id = $office_id and run_id = $run and passed = 1`,
    { run: runId },
  )?.at;
  const approval = office.get<{ at: number | null }>(
    `select max(max(decided_at, coalesce(override_at, 0))) as at from review_verdicts
      where office_id = $office_id and run_id = $run
        and (verdict = 'approved' or override_at is not null)`,
    { run: runId },
  )?.at;
  const times = [verify, approval].filter((at): at is number => typeof at === "number");
  return times.length === 0 ? null : Math.max(...times);
}

/**
 * The run's feedback items that no later green verify or approval answered, oldest first: every
 * item stored after the run's newest such answer. An item and its answer stored at the same moment
 * count as answered.
 */
export function openFeedbackOf(office: OfficeHandle, runId: RunId | string): StoredFeedback[] {
  const answered = lastAnsweredAt(office, runId);
  return storedFeedbackOf(office, runId).filter(
    (item) => answered === null || item.createdAt > answered,
  );
}
