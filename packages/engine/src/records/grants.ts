// The grants of a run (0020): the only way a cap grows after the run started, one `run_grants` row
// each, recorded with the note, the maintainer (origin and client), the time and the caps before
// and after. A run's start snapshot is never changed; `runCaps` (`records/caps.ts`) adds the grants to
// it. Nothing grows a cap by itself.
//
// Two kinds (0020):
// - `budget`: a `--budget` top-up. It grows tokens, turns and minutes by the same share of the
//   run's starting caps; its amount is `{ tokens, turns, minutes, before, after }`.
// - `round`: one more round of the counted cap that fired; its amount is `{ cap, count, before,
//   after }`, with `cap` one of `ROUND_CAPS`.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

export const GRANT_KINDS = ["budget", "round"] as const;

export type GrantKind = (typeof GRANT_KINDS)[number];

/** The counted caps of a run a `round` grant grows (0002, one cap per feedback source). */
export const ROUND_CAPS = ["loops", "reviewRounds", "ciAttempts", "conflictAttempts"] as const;

export type RoundCap = (typeof ROUND_CAPS)[number];

/** A run's developer caps as a budget grant records them. */
export interface GrantCaps {
  readonly budgetTokens: number;
  readonly maxTurns: number;
  readonly maxMinutes: number;
}

/** A budget grant: what it adds to the developer's token, turn and minute caps. */
export interface BudgetGrant {
  readonly tokens: number;
  readonly turns: number;
  readonly minutes: number;
  /** The run's developer caps before and after the grant; a grant written before them has none. */
  readonly before?: GrantCaps;
  readonly after?: GrantCaps;
}

/** A round grant: more rounds of one counted cap. */
export interface RoundGrant {
  readonly cap: RoundCap;
  readonly count: number;
  /** That cap before and after the grant; a grant written before them has none. */
  readonly before?: number;
  readonly after?: number;
}

/** A grant's kind with the amount of that kind. */
export type GrantAmount =
  | { readonly kind: "budget"; readonly amount: BudgetGrant }
  | { readonly kind: "round"; readonly amount: RoundGrant };

/** One grant to write (a `run_grants` row). */
export type NewGrant = GrantAmount & {
  readonly grantId: string;
  readonly note: string | null;
  readonly origin: string;
  readonly client: string | null;
  readonly at: number;
};

/** Records a grant of a run. Runs inside the caller's write transaction. */
export function recordGrant(office: OfficeHandle, runId: RunId, grant: NewGrant): void {
  office.run(
    `insert into run_grants (office_id, run_id, grant_id, kind, amount, note, origin, client, at)
     values ($office_id, $run, $grant, $kind, $amount, $note, $origin, $client, $at)`,
    {
      run: runId,
      grant: grant.grantId,
      kind: grant.kind,
      amount: JSON.stringify(grant.amount),
      note: grant.note,
      origin: grant.origin,
      client: grant.client,
      at: grant.at,
    },
  );
}

/** The sum of a run's grants of each kind. */
export interface GrantTotals {
  readonly budget: { readonly tokens: number; readonly turns: number; readonly minutes: number };
  readonly rounds: Readonly<Record<RoundCap, number>>;
}

/** A finite number field of a JSON object amount; zero when absent or not a number. */
function numberAt(value: unknown, key: string): number {
  if (typeof value !== "object" || value === null) return 0;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function isRoundCap(value: unknown): value is RoundCap {
  return typeof value === "string" && (ROUND_CAPS as readonly string[]).includes(value);
}

/** The sum of a run's grants by kind; a kind with no grant sums to zero. */
export function grantTotals(office: OfficeHandle, runId: RunId): GrantTotals {
  const budget = { tokens: 0, turns: 0, minutes: 0 };
  const rounds: Record<RoundCap, number> = {
    loops: 0,
    reviewRounds: 0,
    ciAttempts: 0,
    conflictAttempts: 0,
  };
  for (const row of office.all<{ kind: GrantKind; amount: string }>(
    `select kind, amount from run_grants where office_id = $office_id and run_id = $run
     order by at, grant_id`,
    { run: runId },
  )) {
    const amount: unknown = JSON.parse(row.amount);
    if (row.kind === "budget") {
      budget.tokens += numberAt(amount, "tokens");
      budget.turns += numberAt(amount, "turns");
      budget.minutes += numberAt(amount, "minutes");
      continue;
    }
    const cap = (amount as { cap?: unknown } | null)?.cap;
    if (isRoundCap(cap)) rounds[cap] += numberAt(amount, "count");
  }
  return { budget, rounds };
}
