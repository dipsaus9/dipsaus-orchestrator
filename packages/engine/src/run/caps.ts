// The engine caps of a run (0008 sections 6 and 9, DIPO-50): budget tokens (input + output + cache
// creation, summed over the run's agents), turns summed by the engine (the CLI's `--max-turns`
// counts again with every queued message, so it is only a backstop) and wall-clock minutes since
// the worker started, sleep included. A cap fires at 100%; the budget is never raised (0001).

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { Caps } from "../workers/types";

/** The cap that fired, as the park detail and the `cap` intent name it. */
export type CapName = "budgetTokens" | "maxTurns" | "maxMinutes";

/** What a run has used so far. */
export interface RunTotals {
  readonly budgetTokens: number;
  readonly turns: number;
  readonly elapsedMs: number;
}

export interface FiredCap {
  readonly cap: CapName;
  /** One line for the park detail, naming the cap, the limit and what was used. */
  readonly detail: string;
}

const MINUTE_MS = 60_000;

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** Pure: the first cap the totals reached, in the order tokens, turns, minutes; null when none. */
export function firedCap(caps: Caps, totals: RunTotals): FiredCap | null {
  if (totals.budgetTokens >= caps.budgetTokens) {
    return {
      cap: "budgetTokens",
      detail: `token budget reached: ${count(totals.budgetTokens)} of ${count(caps.budgetTokens)} budget tokens (input, output and cache creation)`,
    };
  }
  if (totals.turns >= caps.maxTurns) {
    return {
      cap: "maxTurns",
      detail: `turn cap reached: ${count(totals.turns)} of ${count(caps.maxTurns)} turns`,
    };
  }
  if (totals.elapsedMs >= caps.maxMinutes * MINUTE_MS) {
    return {
      cap: "maxMinutes",
      detail: `time cap reached: ${count(Math.floor(totals.elapsedMs / MINUTE_MS))} of ${count(caps.maxMinutes)} minutes since the worker started`,
    };
  }
  return null;
}

/**
 * The run's totals from the stored usage, and the wall-clock time from `startedAt` (when its worker
 * host started) to `now`.
 */
export function runTotals(
  office: OfficeHandle,
  runId: RunId,
  startedAt: number,
  now: number,
): RunTotals {
  const row = office.get<{ budget: number; turns: number }>(
    `select coalesce(sum(input + output + cache_create), 0) as budget,
       coalesce(sum(turns), 0) as turns
     from usage_totals where office_id = $office_id and run_id = $run`,
    { run: runId },
  );
  return {
    budgetTokens: row?.budget ?? 0,
    turns: row?.turns ?? 0,
    elapsedMs: Math.max(0, now - startedAt),
  };
}
