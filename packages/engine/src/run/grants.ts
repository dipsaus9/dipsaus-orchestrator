// The grants of a run (ADR 0020 sections 5 and 15, DIPO-143): what the maintainer or the engine
// added to a run's caps after it started, one `run_grants` row each. A run's start snapshot is
// never changed; `runCaps` (`run/caps.ts`) adds the grants to it.

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

/** One grant to write (a `run_grants` row). */
export interface NewGrant {
  readonly grantId: string;
  readonly kind: GrantKind;
  /** A number for the counted kinds, else a JSON value such as a list of paths. */
  readonly amount: unknown;
  readonly note: string | null;
  readonly origin: string;
  readonly client: string | null;
  readonly at: number;
}

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

/**
 * The sum of a run's numeric grants by kind. A kind with no numeric grant is absent; scope grants
 * and other non-numeric amounts are not summed.
 */
export function grantTotals(
  office: OfficeHandle,
  runId: RunId,
): Partial<Record<GrantKind, number>> {
  const totals: Partial<Record<GrantKind, number>> = {};
  for (const row of office.all<{ kind: GrantKind; amount: string }>(
    `select kind, amount from run_grants where office_id = $office_id and run_id = $run
     order by at, grant_id`,
    { run: runId },
  )) {
    const amount: unknown = JSON.parse(row.amount);
    if (typeof amount === "number") totals[row.kind] = (totals[row.kind] ?? 0) + amount;
  }
  return totals;
}
