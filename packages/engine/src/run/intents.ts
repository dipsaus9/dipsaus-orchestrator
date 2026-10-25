// Pending intents (0008 sections 6 and 7, DIPO-50): every op the engine sends to a running worker
// is stored on the run as `pending` before it is sent, then marked `sent` or `failed`. When the
// worker exits, the outcome is read from the intent first (`outcomeOfIntent`); only an exit no
// intent explains is left to the adapter's `result` (DIPO-51). Writers run inside the caller's
// `office.immediate`.
//
// `sendAsIntent` is the one helper that stores, sends and marks (DIPO-126). Sent with no intent, by
// design (none of them explains an exit, so no intent would be read):
// - closeStdin after a turn whose report ended the run: the report explains the exit (section 7's
//   table), not an engine decision.
// - 0014 nudges: each answers a pending `PostToolUse` or `SessionStart` hook call (section 5) and is
//   counted as a prompt part.
// - `PermissionRequest` hook replies: each answers a pending hook call (section 5) and is recorded
//   as the permission question's close.
// More on `sendAsIntent`. A new intent kind needs a migration (`run_intents.kind` has a CHECK
// constraint) and a row in `INTENT_OUTCOMES` with its test.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import type { HostOp, WorkerOutcome } from "../workers/types";

/**
 * The ops 0008 section 6 names, plus `park`: closing stdin of a worker whose report parks the story
 * (blocked with a question).
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

/** What the helper needs of the steering: the shape of `RunSteering` in `control-types.ts`. */
export interface IntentSteering {
  send(
    office: OfficeHandle,
    runId: RunId,
    ops: readonly HostOp[],
  ): Promise<
    | { readonly ok: true; readonly via?: "socket" | "signal" }
    | { readonly ok: false; readonly reason: string; readonly code?: string }
  >;
}

export interface SendAsIntent<R> {
  readonly kind: IntentKind;
  readonly detail: string;
  /** The ops to send; with none, the intent is only stored and marked sent. */
  readonly ops: readonly HostOp[];
  readonly clock: { now(): number };
  /** Runs after the intent is stored and before the first op is sent; a throw sends nothing. */
  readonly beforeSend?: () => void;
  /** Runs in the transaction that marks the intent, given the failure reason or null. */
  readonly inMark?: (error: string | null, at: number) => R;
}

export interface IntentSent<R> {
  /** The failure reason the host gave, or null when the ops were sent. */
  readonly error: string | null;
  /** `signal` when a verified SIGTERM stopped a follow-only host instead (DIPO-93). */
  readonly via: "socket" | "signal" | undefined;
  readonly marked: R | undefined;
}

/**
 * The one way to send ops to a running worker (0008 sections 6 and 7): stores the intent
 * synchronously (a failed store throws and nothing is sent), sends the ops, then marks the intent
 * `sent`, or `failed` with the reason the host gave or the send threw. `done` rejects only when
 * `beforeSend` or the mark throws; then a `beforeSend` failure leaves the intent pending.
 *
 * Exceptions, sent with no intent (each is an answer to something the worker did, or a send that
 * changes nothing about how the exit reads):
 * - closeStdin after a turn that ended the run (`run/control-turns.ts`, report-driven `ended`):
 *   the exit is explained by the worker's own report, not by an engine decision; an intent kind
 *   would give an outcome the adapter's `result` already gives.
 * - nudges (`hooks/nudges.ts`): one text per tool call, answering a hook call the worker is waiting
 *   on; they are counted as prompt parts (`nudges`) and never explain an exit.
 * - hook replies (`hooks/permissions.ts`): the allow or deny a waiting `PermissionRequest` hook
 *   call gets, recorded as the question's close; it never explains an exit.
 * Record-only sites send no op to a running worker and call `recordIntent` (and `markIntentSent`
 * or `resolveIntent`) directly:
 * - the plan-limit `pause` (`run/outcome-exits.ts`): stored, then resolved `plan-limit` in a second
 *   transaction; never marked sent.
 * - the start-failed `stop` (`run/outcome-sessions.ts`): stored, marked sent and resolved
 *   `startFailed` in one transaction.
 * - the report-feedback `steer` (`run/outcome-exits.ts`): stored and marked sent in one
 *   transaction; its text is the first message of the resume, and it is resolved `resumed` once
 *   that session started.
 * - the park-resume `answer` (`run/resumption.ts`): stored before anything changes, marked sent
 *   later in the resume's own transaction (with the park lift and the answer), then resolved with
 *   how the resume went.
 */
export function sendAsIntent<R = undefined>(
  office: OfficeHandle,
  steering: IntentSteering,
  runId: RunId,
  spec: SendAsIntent<R>,
): { readonly intentId: number; readonly done: Promise<IntentSent<R>> } {
  const intentId = office.immediate(() =>
    recordIntent(office, runId, spec.kind, spec.detail, spec.clock.now()),
  );
  const done = (async (): Promise<IntentSent<R>> => {
    spec.beforeSend?.();
    let error: string | null = null;
    let via: "socket" | "signal" | undefined;
    if (spec.ops.length > 0) {
      try {
        const sent = await steering.send(office, runId, spec.ops);
        if (!sent.ok) error = sent.reason;
        else via = sent.via;
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
    }
    const at = spec.clock.now();
    const marked = office.immediate(() => {
      markIntentSent(office, runId, intentId, at, error);
      return spec.inMark?.(error, at);
    });
    return { error, via, marked };
  })();
  return { intentId, done };
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
