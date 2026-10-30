// The watchdog facts of a run (0009, 0008): `run_signals` rows, one per fact raised, cleared when
// the condition ends. A fact is in effect while its row has no `cleared_at`. The words are the
// evidence of `work.observed` (`no-output`, `same-failure` and `host-lost`); `stuck_at` marks a `no-output` that lasted past the stall wait. The writers run
// inside the caller's immediate transaction; health is derived from the facts in effect
// (`views/work.ts`), never stored.

import type { RunId, WatchdogSignal } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

import { retiredRun } from "./retired";

/** One fact of a run as stored. */
export interface StoredSignal {
  readonly signal: WatchdogSignal;
  readonly since: number;
  readonly clearedAt: number | null;
  /** For `no-output`: when the stall wait passed; null while the run is only quiet. */
  readonly stuckAt: number | null;
}

/** The facts of `runId` in effect, oldest first. */
export function activeSignals(office: OfficeHandle, runId: string): StoredSignal[] {
  return office
    .all<{ signal: string; since: number; stuck_at: number | null }>(
      `select signal, since, stuck_at from run_signals
        where office_id = $office_id and run_id = $run and cleared_at is null
        order by since, signal`,
      { run: runId },
    )
    .map((row) => ({
      signal: row.signal,
      since: row.since,
      clearedAt: null,
      stuckAt: row.stuck_at,
    }));
}

/**
 * Raises `signal` for the run at `at`, unless it is already in effect. Returns the stored fact, or
 * null when it was in effect already.
 */
export function raiseSignal(
  office: OfficeHandle,
  runId: RunId,
  signal: WatchdogSignal,
  at: number,
): StoredSignal | null {
  if (activeSignals(office, runId).some((active) => active.signal === signal)) return null;
  office.run(
    `insert into run_signals (office_id, run_id, signal, since) values ($office_id, $run, $signal, $at)`,
    { run: runId, signal, at },
  );
  return { signal, since: at, clearedAt: null, stuckAt: null };
}

/**
 * Marks the run's `no-output` in effect stuck at `at`, raising it first when none is in effect.
 * Returns the fact, or null when it was stuck already.
 */
export function markStuck(office: OfficeHandle, runId: RunId, at: number): StoredSignal | null {
  const active =
    activeSignals(office, runId).find((fact) => fact.signal === "no-output") ??
    raiseSignal(office, runId, "no-output", at);
  if (active === null || active.stuckAt !== null) return null;
  office.run(
    `update run_signals set stuck_at = $at
      where office_id = $office_id and run_id = $run and signal = 'no-output' and since = $since`,
    { run: runId, since: active.since, at },
  );
  return { ...active, stuckAt: at };
}

/** Clears the run's facts in `signals` that are in effect, at `at`; returns those it cleared. */
export function clearSignals(
  office: OfficeHandle,
  runId: string,
  signals: readonly WatchdogSignal[],
  at: number,
): StoredSignal[] {
  const cleared = activeSignals(office, runId).filter((active) => signals.includes(active.signal));
  for (const active of cleared) {
    office.run(
      `update run_signals set cleared_at = $at
        where office_id = $office_id and run_id = $run and signal = $signal and since = $since`,
      { run: runId, signal: active.signal, since: active.since, at },
    );
  }
  return cleared.map((active) => ({ ...active, clearedAt: at }));
}

/** The facts the next line from the worker clears (0009). */
export const LIVENESS_SIGNALS: readonly WatchdogSignal[] = ["no-output"];

/**
 * Retention (0007): deletes at most `limit` facts of runs retired at `cutoff` (`retiredRun`),
 * inside the caller's transaction; returns how many it deleted.
 */
export function deleteRetiredSignals(office: OfficeHandle, cutoff: number, limit: number): number {
  return office.run(
    `delete from run_signals where rowid in (select rowid from run_signals s
       where s.office_id = $office_id and exists (select 1 from runs r
         where r.office_id = s.office_id and r.run_id = s.run_id and ${retiredRun("r")})
       limit $limit)`,
    { cutoff, limit },
  ).changes;
}
