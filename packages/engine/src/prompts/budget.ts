// The budget line (DIPO-256; 0020 note of 2026-10-20): the last line of every verify, CI, review
// and reject feedback message and of every handoff. It tells the worker its turns, minutes and
// tokens used and left, from the run's caps (start snapshot plus grants), so it can wrap up at
// about 80% of any cap (the worker contract).

/** What a run may use, as `runCaps` gives it. */
export interface BudgetCaps {
  readonly budgetTokens: number;
  readonly maxTurns: number;
  readonly maxMinutes: number;
}

/** What a run has used, as `runTotals` gives it. */
export interface BudgetUsed {
  readonly budgetTokens: number;
  readonly turns: number;
  readonly elapsedMs: number;
}

/** The facts of one budget line. */
export interface BudgetFacts {
  readonly caps: BudgetCaps;
  readonly used: BudgetUsed;
}

const count = (value: number): string => Math.round(value).toLocaleString("en-US");

function part(unit: string, used: number, cap: number): string {
  if (!Number.isFinite(cap)) return `${count(used)} ${unit} used, no ${unit} limit`;
  return `${count(used)} ${unit} used, ${count(Math.max(0, cap - used))} left`;
}

/** One line naming turns, minutes and tokens used and left. */
export function budgetLine(facts: BudgetFacts): string {
  const { caps, used } = facts;
  return `Budget: ${[
    part("turns", used.turns, caps.maxTurns),
    part("minutes", Math.floor(used.elapsedMs / 60_000), caps.maxMinutes),
    part("tokens", used.budgetTokens, caps.budgetTokens),
  ].join("; ")}.`;
}

/** `text` with the budget line as its last line, when there are facts for it. */
export function withBudgetLine(text: string, budget: BudgetFacts | undefined): string {
  return budget === undefined ? text : `${text.trimEnd()}\n${budgetLine(budget)}`;
}
