// Pending intents (0008 sections 6 and 7, DIPO-50): every op the engine sends to a running worker
// is stored on the run as `pending` before it is sent, then marked `sent` or `failed`. When the
// worker exits, the outcome is read from the intent first (`outcomeOfIntent`); only an exit no
// intent explains is left to the adapter's `result` (DIPO-51). Writers run inside the caller's
// `office.immediate`.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { WorkerOutcome } from "../workers/types";

/**
 * The ops 0008 section 6 names, plus `park`: closing stdin of a worker whose report parks the story
 * (blocked with a question or `needsPermission`).
 */
export type IntentKind = "steer" | "answer" | "pause" | "stop" | "reassign" | "cap" | "park";

export type IntentState = "pending" | "sent" | "failed" | "resolved";

export interface StoredIntent {
  readonly intentId: number;
  readonly kind: IntentKind;
  readonly detail: string;
  readonly state: IntentState;
  readonly createdAt: number;
  readonly sentAt: number | null;
  readonly error: string | null;
  readonly resolvedAt: number | null;
  readonly outcome: string | null;
}

interface IntentRow {
  intent_id: number;
  kind: IntentKind;
  detail: string;
  state: IntentState;
  created_at: number;
  sent_at: number | null;
  error: string | null;
  resolved_at: number | null;
  outcome: string | null;
}

function toIntent(row: IntentRow): StoredIntent {
  return {
    intentId: row.intent_id,
    kind: row.kind,
    detail: row.detail,
    state: row.state,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    error: row.error,
    resolvedAt: row.resolved_at,
    outcome: row.outcome,
  };
}

/** Stores a pending intent on the run and returns its id. */
export function recordIntent(
  office: OfficeHandle,
  runId: RunId,
  kind: IntentKind,
  detail: string,
  at: number,
): number {
  const next =
    office.get<{ id: number }>(
      `select coalesce(max(intent_id), 0) + 1 as id from run_intents
       where office_id = $office_id and run_id = $run`,
      { run: runId },
    )?.id ?? 1;
  office.run(
    `insert into run_intents (office_id, run_id, intent_id, kind, detail, state, created_at)
     values ($office_id, $run, $id, $kind, $detail, 'pending', $at)`,
    { run: runId, id: next, kind, detail, at },
  );
  return next;
}

/** Marks an intent sent, or failed with the reason the host gave. */
export function markIntentSent(
  office: OfficeHandle,
  runId: RunId,
  intentId: number,
  at: number,
  error: string | null,
): void {
  office.run(
    `update run_intents set state = $state, sent_at = $at, error = $error
     where office_id = $office_id and run_id = $run and intent_id = $id and state = 'pending'`,
    { state: error === null ? "sent" : "failed", at, error, run: runId, id: intentId },
  );
}

/** The run's intents, oldest first. */
export function runIntents(office: OfficeHandle, runId: RunId): StoredIntent[] {
  return office
    .all<IntentRow>(
      `select intent_id, kind, detail, state, created_at, sent_at, error, resolved_at, outcome
       from run_intents where office_id = $office_id and run_id = $run order by intent_id`,
      { run: runId },
    )
    .map(toIntent);
}

/** The outcome an intent kind gives the exit it explains (0008 section 7); null for none. */
const INTENT_OUTCOMES: Readonly<Partial<Record<IntentKind, WorkerOutcome>>> = {
  stop: "stopped",
  cap: "capped",
  park: "blocked",
  reassign: "reassigned",
};

/**
 * The newest intent that explains a worker's exit, with the outcome it gives, or null when no
 * intent explains it and the adapter's result decides. A pending or failed intent counts too: the
 * engine meant it, so the exit is not a crash.
 */
export function outcomeOfIntent(
  office: OfficeHandle,
  runId: RunId,
): { readonly intent: StoredIntent; readonly outcome: WorkerOutcome } | null {
  const intents = runIntents(office, runId);
  for (let i = intents.length - 1; i >= 0; i--) {
    const intent = intents[i];
    if (intent === undefined) continue;
    const outcome = INTENT_OUTCOMES[intent.kind];
    if (outcome !== undefined) return { intent, outcome };
  }
  return null;
}

/** Marks the intent that explained the exit as resolved with its outcome. */
export function resolveIntent(
  office: OfficeHandle,
  runId: RunId,
  intentId: number,
  outcome: string,
  at: number,
): void {
  office.run(
    `update run_intents set state = 'resolved', resolved_at = $at, outcome = $outcome
     where office_id = $office_id and run_id = $run and intent_id = $id and resolved_at is null`,
    { at, outcome, run: runId, id: intentId },
  );
}
