// The persisted occupant of the office merge slot (0019 sections 9 and 16, migration 48): one row
// of `merge_slot` per office while a PR is in the slot, deleted when it merges or leaves. The slot
// reads it at every tick, so a daemon restart continues with the same occupant at the same step.
// Writes run inside the caller's transaction.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { CatchUpMerged, ConflictItem } from "../box/collisions";
import type { OfficeHandle } from "../db/office";

/** The steps of a stay in the slot, in order (a backlog PR skips `close-out` and `push`). */
/**
 * `record` follows a sync that planned a merge of the base: the branch moves to it and the merge is
 * recorded, from the persisted `merge`, so a restart in between finds the merge.
 */
export type SlotPhase = "close-out" | "sync" | "record" | "push" | "checks" | "merge";

/** A merge of the base the sync planned and the conflict item for the worker, if it conflicted. */
export interface SlotMerge {
  readonly merged: CatchUpMerged;
  readonly item: ConflictItem | null;
}

/** How the next sync merges the base (0016 amendment of 2026-10-22). */
export type SlotSyncMode = "onConflict" | "always";

export interface SlotOccupant {
  readonly kind: "story" | "backlog";
  readonly number: number;
  readonly repo: string;
  readonly branch: string;
  /** The story run of a story PR; null for a backlog PR. */
  readonly runId: RunId | null;
  readonly phase: SlotPhase;
  /** The head the slot pushed and waits on; null before the slot pushed. */
  readonly head: string | null;
  /** Host merges tried in this stay. */
  readonly attempts: number;
  /** When the slot started waiting for the checks of `head`. */
  readonly checksSince: number | null;
  readonly syncMode: SlotSyncMode;
  /** The merge of the base the sync planned, while the step is `record`; null otherwise. */
  readonly merge?: SlotMerge | null;
  readonly enteredAt: number;
}

interface Row {
  kind: "story" | "backlog";
  pr_number: number;
  repo: string;
  branch: string;
  run_id: string | null;
  phase: SlotPhase;
  pushed_head: string | null;
  attempts: number;
  checks_since: number | null;
  sync_mode: SlotSyncMode;
  merge: string | null;
  entered_at: number;
}

/** The office's slot occupant, or null when the slot is free. */
export function slotOccupant(office: OfficeHandle): SlotOccupant | null {
  const row = office.get<Row>(
    `select kind, pr_number, repo, branch, run_id, phase, pushed_head, attempts, checks_since,
            sync_mode, merge, entered_at
       from merge_slot where office_id = $office_id`,
  );
  if (row === null) return null;
  return {
    kind: row.kind,
    number: row.pr_number,
    repo: row.repo,
    branch: row.branch,
    runId: row.run_id as RunId | null,
    phase: row.phase,
    head: row.pushed_head,
    attempts: row.attempts,
    checksSince: row.checks_since,
    syncMode: row.sync_mode,
    merge: row.merge === null ? null : (JSON.parse(row.merge) as SlotMerge),
    enteredAt: row.entered_at,
  };
}

/** Puts `occupant` in the office's slot, replacing whatever row was there. */
export function enterSlot(office: OfficeHandle, occupant: SlotOccupant): void {
  office.run(
    `insert or replace into merge_slot (office_id, kind, pr_number, repo, branch, run_id, phase,
       pushed_head, attempts, checks_since, sync_mode, merge, entered_at)
     values ($office_id, $kind, $number, $repo, $branch, $run, $phase, $head, $attempts, $since,
       $mode, $merge, $at)`,
    {
      kind: occupant.kind,
      number: occupant.number,
      repo: occupant.repo,
      branch: occupant.branch,
      run: occupant.runId,
      phase: occupant.phase,
      head: occupant.head,
      attempts: occupant.attempts,
      since: occupant.checksSince,
      mode: occupant.syncMode,
      merge: occupant.merge == null ? null : JSON.stringify(occupant.merge),
      at: occupant.enteredAt,
    },
  );
}

/** Moves the occupant on: the given fields change, the rest stays. */
export function updateSlot(
  office: OfficeHandle,
  change: Partial<
    Pick<SlotOccupant, "phase" | "head" | "attempts" | "checksSince" | "syncMode" | "merge">
  >,
): void {
  const current = slotOccupant(office);
  if (current === null) return;
  enterSlot(office, { ...current, ...change });
}

/** Frees the office's slot: the PR merged or left. */
export function leaveSlot(office: OfficeHandle): void {
  office.run("delete from merge_slot where office_id = $office_id");
}

/** True when the story run `runId` is in the office's merge slot. */
export function runInSlot(office: OfficeHandle, runId: RunId | string): boolean {
  return (
    office.get("select 1 as found from merge_slot where office_id = $office_id and run_id = $run", {
      run: runId,
    }) !== null
  );
}
