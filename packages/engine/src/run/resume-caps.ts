// The cap arithmetic of a park resume (ADR 0020 sections 4 and 5, DIPO-155): a top-up as a budget
// grant, the caps a run will have once a resume's grants are recorded, what a parked run used, and
// the smallest share that clears a cap. Pure but for `usedOf`, which reads the run's usage.

import type { ResumeBudget } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { Caps } from "../workers/types";

import { type RunCaps, type RunTotals, runTotals } from "./caps";
import type { GrantAmount } from "./grants";
import { capsStartedAt, type StoredRun } from "./records";
import type { ResumeSession } from "./resume-policy";

/** The share of the starting caps the `capped` row and a reviewer cap grow by (0020 amendment). */
export const HALF_SHARE = 50;

/** One grant as the intent stores it, written in the resume's transaction. */
export interface PlannedGrant {
  readonly grantId: string;
  readonly amount: GrantAmount;
}

function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** The run's starting developer caps: its snapshot, `legacy` for a run that kept none. */
export function startCaps(run: StoredRun, legacy: Caps): Caps {
  return {
    budgetTokens: run.budgetLimit,
    maxTurns: run.maxTurns ?? legacy.maxTurns,
    maxMinutes: run.maxMinutes ?? legacy.maxMinutes,
  };
}

/**
 * A top-up as a budget grant (0020 section 4): a share (a percent) grows tokens, turns and minutes
 * by that share of the starting caps; a token amount is tokens, and turns and minutes grow by the
 * share that amount is of the starting budget. No budget is the `capped` row's half.
 */
export function share(
  start: Caps,
  budget: ResumeBudget | undefined,
): { readonly tokens: number; readonly turns: number; readonly minutes: number } {
  if (budget !== undefined && "tokens" in budget) {
    const fraction = start.budgetTokens <= 0 ? 0 : budget.tokens / start.budgetTokens;
    return {
      tokens: budget.tokens,
      turns: Math.ceil(start.maxTurns * fraction),
      minutes: Math.ceil(start.maxMinutes * fraction),
    };
  }
  const fraction = (budget?.share ?? HALF_SHARE) / 100;
  return {
    tokens: Math.round(start.budgetTokens * fraction),
    turns: Math.ceil(start.maxTurns * fraction),
    minutes: Math.ceil(start.maxMinutes * fraction),
  };
}

export function budgetText(budget: ResumeBudget): string {
  return "share" in budget ? `+${budget.share}%` : `+${count(budget.tokens)} tokens`;
}

/** `caps` with the grants added, as `runCaps` reads them once they are recorded. */
export function withGrants(caps: RunCaps, grants: readonly PlannedGrant[]): RunCaps {
  let next = caps;
  for (const { amount } of grants) {
    switch (amount.kind) {
      case "budget":
        next = {
          ...next,
          budgetTokens: next.budgetTokens + amount.amount.tokens,
          maxTurns: next.maxTurns + amount.amount.turns,
          maxMinutes: next.maxMinutes + amount.amount.minutes,
        };
        break;
      case "loop":
        next = { ...next, loopCap: next.loopCap + amount.amount };
        break;
      case "reviewRound":
        next = { ...next, reviewRoundCap: plus(next.reviewRoundCap, amount.amount) };
        break;
      case "ciAttempt":
        next = { ...next, ciCap: plus(next.ciCap, amount.amount) };
        break;
      case "conflictHandoff":
        next = { ...next, conflictCap: plus(next.conflictCap, amount.amount) };
        break;
      case "reviewCap":
        next = {
          ...next,
          reviewMaxTurns: plus(next.reviewMaxTurns, amount.amount.turns),
          reviewMaxMinutes: plus(next.reviewMaxMinutes, amount.amount.minutes),
        };
        break;
      case "scope":
        break;
    }
  }
  return next;
}

function plus(cap: number | null, grant: number): number | null {
  return cap === null ? null : cap + grant;
}

/** What the parked run used: its tokens and turns, and the minutes it worked until it ended. */
export function usedOf(office: OfficeHandle, run: StoredRun): RunTotals {
  const host = office.get<{ started_at: number | null }>(
    `select min(started_at) as started_at from worker_hosts
      where office_id = $office_id and run_id = $run`,
    { run: run.runId },
  );
  const startedAt = capsStartedAt(run, host?.started_at);
  return runTotals(office, run.runId, startedAt, run.endedAt ?? startedAt);
}

/** How far `value` is past `cap`, as a share of `base`; zero for a cap that is not counted. */
function over(value: number, cap: number, base: number): number {
  return base <= 0 || !Number.isFinite(cap) ? 0 : (value - cap) / base;
}

/**
 * The smallest whole share of the starting caps after which none of the caps a session counts is
 * reached (`resume.topUpTooSmall`, 0020 section 4).
 */
export function smallestShare(
  start: Caps,
  caps: Caps,
  used: RunTotals,
  session: ResumeSession,
): number {
  const needs = [over(used.budgetTokens, caps.budgetTokens, start.budgetTokens)];
  if (session !== "review") {
    needs.push(over(used.turns, caps.maxTurns, start.maxTurns));
    needs.push(over(used.elapsedMs / 60_000, caps.maxMinutes, start.maxMinutes));
  }
  return Math.max(1, Math.floor(Math.max(0, ...needs) * 100) + 1);
}
