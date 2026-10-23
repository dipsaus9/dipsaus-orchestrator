// The facts of a run's budget line (DIPO-256): its caps with grants and what it has used now.

import type { OfficeHandle } from "../db/office";
import type { BudgetFacts } from "../prompts/budget";

import { runCaps, runTotals } from "./caps";
import { capsStartedAt, type StoredRun } from "./records";

/** The caps and usage of `run` as of `now`, counted from the first start of its worker host. */
export function runBudgetFacts(office: OfficeHandle, run: StoredRun, now: number): BudgetFacts {
  const host = office.get<{ started_at: number | null }>(
    `select min(started_at) as started_at from worker_hosts
      where office_id = $office_id and run_id = $run`,
    { run: run.runId },
  );
  return {
    caps: runCaps(office, run),
    used: runTotals(office, run.runId, capsStartedAt(run, host?.started_at), now),
  };
}
