// The facts of the maintainer's steer and pause (ADR 0020 section 9, 0008 section 6, DIPO-163).
// Both live as intents on the run (`run_intents`), so nothing new is stored:
//
// - `pause` `maintainer-pause`: the run is paused while the intent is unresolved. It is resolved by
//   `work.resume` (outcome `resumed`, or `resume-queued` while the resume waits for the worker
//   place) or by the end of the run (`run-ended`). The time from its creation to its resolution is
//   the run's paused time, which the minute cap leaves out (`pausedMs`). The worker's exit after
//   the 10 minutes does not resolve it: the run stays paused, without a session and without a
//   place, until the maintainer resumes it.
// - `steer` `maintainer-steer <request> <text>`: a steer, keyed by its request. A steer sent to a
//   live worker is `sent` at once. One for a paused or parked story stays `pending` until the first
//   message of the next session carries it (`heldMessages`, `markHeldSent`).
// - `steer` `held-feedback <text>`: an engine feedback item (verify) that arrived while the run was
//   paused; it waits like a held steer.
//
// Plain functions over the office database, with no dependency on the run services, so the caps,
// the places and the work view can read them.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

/** The tags the intents' details start with. */
export const MAINTAINER_TAGS = {
  pause: "maintainer-pause",
  steer: "maintainer-steer",
  held: "held-feedback",
} as const;

/** How long a pause keeps the worker's process before stdin closes (0008 section 6). */
export const PAUSE_CLOSE_MS = 10 * 60_000;

/** The outcomes a maintainer pause is resolved with. */
export const PAUSE_OUTCOMES = {
  resumed: "resumed",
  /** The resume waits for the worker place; the place's starter starts the session. */
  resumeQueued: "resume-queued",
  runEnded: "run-ended",
  /** The pause never reached the worker, so it is no pause. */
  sendFailed: "send-failed",
} as const;

/** A pause in effect. */
export interface OpenPause {
  readonly intentId: number;
  /** When the pause was stored. */
  readonly since: number;
}

/** The run's pause in effect, or null. */
export function openPause(office: OfficeHandle, runId: RunId | string): OpenPause | null {
  const row = office.get<{ intent_id: number; created_at: number }>(
    `select intent_id, created_at from run_intents
      where office_id = $office_id and run_id = $run and kind = 'pause'
        and detail like $tag and resolved_at is null
      order by intent_id desc limit 1`,
    { run: runId, tag: `${MAINTAINER_TAGS.pause}%` },
  );
  return row === null ? null : { intentId: row.intent_id, since: row.created_at };
}

/** The ms the run was paused by the maintainer up to `now`; the minute cap leaves them out. */
export function pausedMs(office: OfficeHandle, runId: RunId | string, now: number): number {
  const row = office.get<{ total: number | null }>(
    `select sum(max(0, coalesce(resolved_at, $now) - created_at)) as total from run_intents
      where office_id = $office_id and run_id = $run and kind = 'pause' and detail like $tag`,
    { run: runId, now, tag: `${MAINTAINER_TAGS.pause}%` },
  );
  return row?.total ?? 0;
}

/**
 * True when the run is paused and its worker has exited (the 10 minutes passed): it holds no
 * session place then. Inside any transaction.
 */
export function pausedWithoutSession(office: OfficeHandle, runId: RunId | string): boolean {
  if (openPause(office, runId) === null) return false;
  const agent = office.get<{ ended_at: number | null }>(
    `select ended_at from agents where office_id = $office_id and run_id = $run
      order by started_at desc, rowid desc limit 1`,
    { run: runId },
  );
  return agent === null || agent.ended_at !== null;
}

/** Resolves the run's open maintainer pauses with `outcome` at `at`. Inside the caller's transaction. */
export function resolvePauses(
  office: OfficeHandle,
  runId: RunId | string,
  outcome: string,
  at: number,
): void {
  office.run(
    `update run_intents set state = 'resolved', resolved_at = $at, outcome = $outcome
      where office_id = $office_id and run_id = $run and kind = 'pause' and detail like $tag
        and resolved_at is null`,
    { run: runId, at, outcome, tag: `${MAINTAINER_TAGS.pause}%` },
  );
}

/** The run's newest pause whose resume waits for the worker place, or null. */
export function queuedPauseResume(office: OfficeHandle, runId: RunId | string): number | null {
  const row = office.get<{ intent_id: number; resolved_at: number }>(
    `select intent_id, resolved_at from run_intents
      where office_id = $office_id and run_id = $run and kind = 'pause' and detail like $tag
        and outcome = $outcome
      order by intent_id desc limit 1`,
    { run: runId, tag: `${MAINTAINER_TAGS.pause}%`, outcome: PAUSE_OUTCOMES.resumeQueued },
  );
  if (row === null) return null;
  const later = office.get(
    `select 1 as found from agents where office_id = $office_id and run_id = $run
      and started_at >= $at limit 1`,
    { run: runId, at: row.resolved_at },
  );
  return later === null ? row.intent_id : null;
}

/** Marks a queued pause resume as started. */
export function markPauseResumed(office: OfficeHandle, runId: RunId | string, id: number): void {
  office.run(
    `update run_intents set outcome = $outcome
      where office_id = $office_id and run_id = $run and intent_id = $id`,
    { run: runId, id, outcome: PAUSE_OUTCOMES.resumed },
  );
}

/** A message that waits for the next session of a run. */
export interface HeldMessages {
  readonly ids: readonly number[];
  /** The texts in the order they were stored, steers already wrapped by `wrap`. */
  readonly texts: readonly string[];
}

/** The steers and feedback items waiting for the run's next message, oldest first. */
export function heldMessages(
  office: OfficeHandle,
  runId: RunId | string,
  wrap: (steer: string) => string,
): HeldMessages {
  const rows = office.all<{ intent_id: number; detail: string }>(
    `select intent_id, detail from run_intents
      where office_id = $office_id and run_id = $run and kind = 'steer' and state = 'pending'
        and (detail like $steer or detail like $held)
      order by intent_id`,
    { run: runId, steer: `${MAINTAINER_TAGS.steer} %`, held: `${MAINTAINER_TAGS.held} %` },
  );
  return {
    ids: rows.map((row) => row.intent_id),
    texts: rows.map((row) =>
      row.detail.startsWith(`${MAINTAINER_TAGS.held} `)
        ? row.detail.slice(MAINTAINER_TAGS.held.length + 1)
        : wrap(steerTextOf(row.detail)),
    ),
  };
}

/** The text of a `maintainer-steer <request> <text>` detail. */
export function steerTextOf(detail: string): string {
  const afterTag = detail.slice(MAINTAINER_TAGS.steer.length + 1);
  const space = afterTag.indexOf(" ");
  return space === -1 ? "" : afterTag.slice(space + 1);
}

/** Marks held messages as sent with the session's first message. */
export function markHeldSent(
  office: OfficeHandle,
  runId: RunId | string,
  ids: readonly number[],
  at: number,
): void {
  for (const id of ids) {
    office.run(
      `update run_intents set state = 'resolved', sent_at = $at, resolved_at = $at,
         outcome = 'resumed'
        where office_id = $office_id and run_id = $run and intent_id = $id and state = 'pending'`,
      { run: runId, id, at },
    );
  }
}

/** A stored steer, found by its request key. */
export interface StoredSteer {
  readonly runId: string;
  readonly state: string;
}

/** The steer stored for `key` (a request id), unless its send failed. */
export function findSteer(office: OfficeHandle, key: string): StoredSteer | null {
  const row = office.get<{ run_id: string; state: string }>(
    `select run_id, state from run_intents
      where office_id = $office_id and kind = 'steer' and state != 'failed'
        and detail like $prefix
      order by created_at desc limit 1`,
    { prefix: `${MAINTAINER_TAGS.steer} ${key} %` },
  );
  return row === null ? null : { runId: row.run_id, state: row.state };
}
