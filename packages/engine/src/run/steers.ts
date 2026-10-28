// The facts of the maintainer's steer (0020, 0008, DIPO-163). They live as intents on the run
// (`run_intents`), so nothing new is stored:
//
// - `steer` `maintainer-steer <request> <text>`: a steer, keyed by its request. A steer sent to a
//   live worker is `sent` at once. One for a parked story, or a run between two sessions, stays
//   `pending` until the first message of the next session carries it (`heldMessages`,
//   `markHeldSent`).
// - `steer` `held-feedback <text>`: an engine feedback item, or the note of a resumed fix round,
//   that waits for the next session like a held steer.
//
// Plain functions over the office database, with no dependency on the run services.

import type { RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

/** The tags the intents' details start with. */
export const MAINTAINER_TAGS = {
  steer: "maintainer-steer",
  held: "held-feedback",
} as const;

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
