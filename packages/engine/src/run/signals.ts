// Watchdog signals of a run (0009 section 3, 0008 section 3): `run_signals` rows, one per signal
// raised, cleared when the condition ends. A signal is in effect while its row has no
// `cleared_at`. The writers run inside the caller's immediate transaction; health is derived from
// the signals in effect (`views/work.ts`), never stored.

import type { RunId, WatchdogSignal } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

/** One signal of a run as stored. */
export interface StoredSignal {
  readonly signal: WatchdogSignal;
  readonly since: number;
  readonly clearedAt: number | null;
}

/** The signals of `runId` in effect, oldest first. */
export function activeSignals(office: OfficeHandle, runId: string): StoredSignal[] {
  return office
    .all<{ signal: string; since: number }>(
      `select signal, since from run_signals
        where office_id = $office_id and run_id = $run and cleared_at is null
        order by since, signal`,
      { run: runId },
    )
    .map((row) => ({ signal: row.signal, since: row.since, clearedAt: null }));
}

/**
 * Raises `signal` for the run at `at`, unless it is already in effect. Returns the stored signal,
 * or null when it was in effect already.
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
  return { signal, since: at, clearedAt: null };
}

/** Clears the run's signals in `signals` that are in effect, at `at`; returns those it cleared. */
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

/** The signals the next line from the worker clears (0009 section 3). */
export const LIVENESS_SIGNALS: readonly WatchdogSignal[] = ["quiet", "no-output"];
