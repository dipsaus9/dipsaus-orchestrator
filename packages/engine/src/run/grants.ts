// The grants of a run (ADR 0020 sections 5 and 15, DIPO-143): what the maintainer or the engine
// added to a run's caps after it started, one `run_grants` row each. A run's start snapshot is
// never changed; `runCaps` (`run/caps.ts`) adds the grants to it.
//
// The `amount` JSON per kind (0020 section 5): a budget grant carries tokens, turns and minutes;
// `loop`, `reviewRound`, `ciAttempt` and `conflictHandoff` carry a count; `reviewCap` carries the
// reviewer's turns and minutes; `scope` carries the granted paths.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

export const GRANT_KINDS = [
  "budget",
  "loop",
  "reviewRound",
  "ciAttempt",
  "conflictHandoff",
  "reviewCap",
  "scope",
] as const;

export type GrantKind = (typeof GRANT_KINDS)[number];

/** A budget grant: what it adds to the developer's token, turn and minute caps. */
export interface BudgetGrant {
  readonly tokens: number;
  readonly turns: number;
  readonly minutes: number;
  /**
   * The run's developer caps before and after the grant (0020 section 4, DIPO-155); a maintainer
   * top-up records them, a grant written before them has none.
   */
  readonly before?: GrantCaps;
  readonly after?: GrantCaps;
}

/** A run's developer caps as a budget grant records them. */
export interface GrantCaps {
  readonly budgetTokens: number;
  readonly maxTurns: number;
  readonly maxMinutes: number;
}

/** A reviewer cap grant: what it adds to the reviewer's own turn and minute caps. */
export interface ReviewCapGrant {
  readonly turns: number;
  readonly minutes: number;
}

/** The kinds whose amount is a count of extra rounds, hand-offs or attempts. */
export type CountedGrantKind = "loop" | "reviewRound" | "ciAttempt" | "conflictHandoff";

/** A grant's kind with the amount of that kind. */
export type GrantAmount =
  | { readonly kind: "budget"; readonly amount: BudgetGrant }
  | { readonly kind: CountedGrantKind; readonly amount: number }
  | { readonly kind: "reviewCap"; readonly amount: ReviewCapGrant }
  | { readonly kind: "scope"; readonly amount: readonly string[] };

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

/** The sum of a run's grants of each kind; scope grants hold paths and are not summed. */
export interface GrantTotals {
  readonly budget: BudgetGrant;
  readonly loop: number;
  readonly reviewRound: number;
  readonly ciAttempt: number;
  readonly conflictHandoff: number;
  readonly reviewCap: ReviewCapGrant;
}

/** A finite number field of a JSON object amount; zero when absent or not a number. */
function numberAt(value: unknown, key: string): number {
  if (typeof value !== "object" || value === null) return 0;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

/** The sum of a run's grants by kind; a kind with no grant sums to zero. */
export function grantTotals(office: OfficeHandle, runId: RunId): GrantTotals {
  const budget = { tokens: 0, turns: 0, minutes: 0 };
  const reviewCap = { turns: 0, minutes: 0 };
  const counted: Record<CountedGrantKind, number> = {
    loop: 0,
    reviewRound: 0,
    ciAttempt: 0,
    conflictHandoff: 0,
  };
  for (const row of office.all<{ kind: GrantKind; amount: string }>(
    `select kind, amount from run_grants where office_id = $office_id and run_id = $run
     order by at, grant_id`,
    { run: runId },
  )) {
    const amount: unknown = JSON.parse(row.amount);
    switch (row.kind) {
      case "budget":
        budget.tokens += numberAt(amount, "tokens");
        budget.turns += numberAt(amount, "turns");
        budget.minutes += numberAt(amount, "minutes");
        break;
      case "reviewCap":
        reviewCap.turns += numberAt(amount, "turns");
        reviewCap.minutes += numberAt(amount, "minutes");
        break;
      case "scope":
        break;
      default:
        if (typeof amount === "number" && Number.isFinite(amount)) counted[row.kind] += amount;
    }
  }
  return { budget, reviewCap, ...counted };
}
