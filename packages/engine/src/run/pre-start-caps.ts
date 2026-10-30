// The cap check before a session starts for a run that already used its caps (DIPO-205; 0020
// amendment of 2026-10-19). A fix round or conflict hand-off after a done path that crossed a cap
// would start a worker that its own caps stop at once, so `Places.drain` asks `reachedCaps` before
// the starter of such a wait is called, and parks the story `budget-exceeded` with
// the cap detail instead. The park stores a `cap` intent without ops, as no worker runs.

import type { OfficeHandle } from "../db/office";

import { type FiredCap, firedCap, runCaps, runTotals } from "../records/caps";
import type { RunEnding } from "./control-types";
import { resolveIntent, runIntents } from "../records/intents";
import { capsStartedAt, type StoredRun } from "../records/run-records";

/** The cap the run's stored caps and usage have reached now, or null. */
export function reachedCaps(office: OfficeHandle, run: StoredRun, now: number): FiredCap | null {
  const host = office.get<{ started_at: number | null }>(
    `select min(started_at) as started_at from worker_hosts
      where office_id = $office_id and run_id = $run`,
    { run: run.runId },
  );
  return firedCap(
    runCaps(office, run),
    runTotals(office, run.runId, capsStartedAt(run, host?.started_at), now),
  );
}

/** The ending of a run parked before its session started. */
export function preStartEnding(fired: FiredCap): RunEnding {
  return {
    intent: "cap",
    ops: [],
    reason: "budget-exceeded",
    detail: fired.detail,
  };
}

/** Resolves the `cap` intent of a park made without a worker, so nothing explains a later exit. */
export function resolvePreStartIntent(office: OfficeHandle, run: StoredRun, at: number): void {
  const intent = runIntents(office, run.runId)
    .filter((candidate) => candidate.kind === "cap" && candidate.resolvedAt === null)
    .at(-1);
  if (intent !== undefined) {
    office.immediate(() => resolveIntent(office, run.runId, intent.intentId, "capped", at));
  }
}
