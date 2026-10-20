// The engine caps of a run (0008 sections 6 and 9, DIPO-50): budget tokens (input + output + cache
// creation, summed over the run's agents), turns summed by the engine (the CLI's `--max-turns`
// counts again with every queued message, so it is only a backstop) and wall-clock minutes since
// the worker started, sleep included. A cap fires at 100%; the budget is never raised (0001).

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { Caps } from "../workers/types";

import { grantTotals } from "./grants";
import type { StoredRun } from "./records";

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

/** The role of a run's reviewer agents (0019 section 4); its turns and minutes are its own. */
export const REVIEWER_ROLE = "reviewer";

/**
 * The run's totals from the stored usage, and the wall-clock time from `startedAt` (when its worker
 * host started, moved by the time it stood parked, ended or in review) to `now`. The budget counts
 * every agent of the run, the reviewer's too, since the story's budget pays for its review; the
 * turns count only the developer's agents, since a reviewer's turns count only toward its own
 * session cap (0019 sections 4 and 13).
 */
export function runTotals(
  office: OfficeHandle,
  runId: RunId,
  startedAt: number,
  now: number,
): RunTotals {
  const row = office.get<{ budget: number; turns: number }>(
    `select coalesce(sum(t.input + t.output + t.cache_create), 0) as budget,
       coalesce(sum(case when coalesce(a.role, t.role) = $reviewer then 0 else t.turns end), 0)
         as turns
     from usage_totals t
     left join agents a on a.office_id = t.office_id and a.agent_id = t.agent_id
     where t.office_id = $office_id and t.run_id = $run`,
    { run: runId, reviewer: REVIEWER_ROLE },
  );
  return {
    budgetTokens: row?.budget ?? 0,
    turns: row?.turns ?? 0,
    elapsedMs: Math.max(0, now - startedAt),
  };
}

/**
 * The caps a run counts against: the `Caps` the workers get, plus the loop cap and the review
 * loop's caps (0019 sections 4 and 8). A review loop cap is null for a run that has none: a session
 * run, or a run started before it was kept (DIPO-146).
 */
export interface RunCaps extends Caps {
  readonly loopCap: number;
  readonly reviewRoundCap: number | null;
  readonly ciCap: number | null;
  readonly conflictCap: number | null;
  /** The reviewer's own session caps (0019 section 4); never the developer's. */
  readonly reviewMaxTurns: number | null;
  readonly reviewMaxMinutes: number | null;
  /** Tokens added to the budget per review round started (0019 section 4); no grant adds to it. */
  readonly reviewAllowance: number | null;
}

/** A snapshot cap plus its grants; a cap the run has none of stays null. */
function granted(cap: number | null | undefined, grant: number): number | null {
  return cap == null ? null : cap + grant;
}

/**
 * The caps of a run now (ADR 0020 section 5, DIPO-143): its start snapshot plus the sum of its
 * grants of each kind. A budget grant raises tokens, turns and minutes; a `loop` grant the loop
 * cap; a `reviewRound` grant the review round cap; `ciAttempt` and `conflictHandoff` grants the CI
 * and conflict caps; a `reviewCap` grant the reviewer's turn and minute caps (DIPO-146). The tier
 * of the office is never read for a snapshot, so an edit of the tier reaches new runs only.
 * `legacy` supplies turns and minutes for a run started before they were kept; without it those
 * are unbounded.
 */
export function runCaps(
  office: OfficeHandle,
  run: StoredRun,
  legacy?: Pick<Caps, "maxTurns" | "maxMinutes">,
): RunCaps {
  const grants = grantTotals(office, run.runId);
  return {
    budgetTokens: run.budgetLimit + grants.budget.tokens,
    maxTurns: (run.maxTurns ?? legacy?.maxTurns ?? Number.POSITIVE_INFINITY) + grants.budget.turns,
    maxMinutes:
      (run.maxMinutes ?? legacy?.maxMinutes ?? Number.POSITIVE_INFINITY) + grants.budget.minutes,
    loopCap: run.loopCap + grants.loop,
    reviewRoundCap: granted(run.reviewRoundCap, grants.reviewRound),
    ciCap: granted(run.ciCap, grants.ciAttempt),
    conflictCap: granted(run.conflictCap, grants.conflictHandoff),
    reviewMaxTurns: granted(run.reviewMaxTurns, grants.reviewCap.turns),
    reviewMaxMinutes: granted(run.reviewMaxMinutes, grants.reviewCap.minutes),
    reviewAllowance: run.reviewAllowance ?? null,
  };
}
