// The cap arithmetic of a park resume (0020): a top-up as a budget grant, the caps a run will have
// once a resume's grants are recorded, what a parked run used, and the smallest share that clears
// a cap. Pure but for `usedOf`, which reads the run's usage. Every top-up is the maintainer's
// `--budget`; nothing here grows a cap by a share of its own.

import type { ResumeBudget } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { Caps } from "../workers/types";

import { type RunCaps, type RunTotals, runTotals } from "./caps";
import type { GrantAmount, RoundCap } from "./grants";
import { capsStartedAt, type StoredRun } from "./records";

/** One grant as the intent stores it, written in the resume's transaction. */
export interface PlannedGrant {
  readonly grantId: string;
  readonly amount: GrantAmount;
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
 * A `--budget` top-up as a budget grant (0020): a share (a percent) grows tokens, turns and
 * minutes by that share of the starting caps; a token amount is tokens, and turns and minutes grow
 * by the share that amount is of the starting budget.
 */
export function share(
  start: Caps,
  budget: ResumeBudget,
): { readonly tokens: number; readonly turns: number; readonly minutes: number } {
  if ("tokens" in budget) {
    const fraction = start.budgetTokens <= 0 ? 0 : budget.tokens / start.budgetTokens;
    return {
      tokens: budget.tokens,
      turns: Math.ceil(start.maxTurns * fraction),
      minutes: Math.ceil(start.maxMinutes * fraction),
    };
  }
  const fraction = budget.share / 100;
  return {
    tokens: Math.round(start.budgetTokens * fraction),
    turns: Math.ceil(start.maxTurns * fraction),
    minutes: Math.ceil(start.maxMinutes * fraction),
  };
}

export function budgetText(budget: ResumeBudget): string {
  return "share" in budget
    ? `+${budget.share}%`
    : `+${Math.round(budget.tokens).toLocaleString("en-US")} tokens`;
}

/** The field of `RunCaps` a round grant of `cap` grows. */
export const ROUND_CAP_FIELDS: Readonly<
  Record<RoundCap, "loopCap" | "reviewRoundCap" | "ciCap" | "conflictCap">
> = {
  loops: "loopCap",
  reviewRounds: "reviewRoundCap",
  ciAttempts: "ciCap",
  conflictAttempts: "conflictCap",
};

/** `caps` with the grants added, as `runCaps` reads them once they are recorded. */
export function withGrants(caps: RunCaps, grants: readonly PlannedGrant[]): RunCaps {
  let next = caps;
  for (const { amount } of grants) {
    if (amount.kind === "budget") {
      next = {
        ...next,
        budgetTokens: next.budgetTokens + amount.amount.tokens,
        maxTurns: next.maxTurns + amount.amount.turns,
        maxMinutes: next.maxMinutes + amount.amount.minutes,
      };
      continue;
    }
    const field = ROUND_CAP_FIELDS[amount.amount.cap];
    const cap = next[field];
    if (cap !== null) next = { ...next, [field]: cap + amount.amount.count };
  }
  return next;
}

/** What the parked run's developer used: tokens and turns, and the minutes it worked. */
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
 * The smallest whole share of the starting caps after which none of the developer's caps is
 * reached (`resume.topUpTooSmall`, 0020).
 */
export function smallestShare(start: Caps, caps: Caps, used: RunTotals): number {
  const needs = [
    over(used.budgetTokens, caps.budgetTokens, start.budgetTokens),
    over(used.turns, caps.maxTurns, start.maxTurns),
    over(used.elapsedMs / 60_000, caps.maxMinutes, start.maxMinutes),
  ];
  return Math.max(1, Math.floor(Math.max(0, ...needs) * 100) + 1);
}
