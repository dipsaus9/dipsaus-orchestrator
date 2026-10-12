// Replay from a cursor (0005 section 8, 0007 section 7). A reconnecting client sends the last
// cursor it saw; the engine returns the stored entries after it, or `stream.resetRequired` with the
// oldest cursor it can still replay from when the cursor has another epoch or is below the floor.

import {
  type Cursor,
  engineError,
  type EngineError,
  type RequestId,
  type RunId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

import { cursorAt, type LogTier, officeStream, readLogState, type StoredEntry } from "./log";

export type ReplayResult =
  | { readonly ok: true; readonly entries: readonly StoredEntry[]; readonly head: Cursor }
  | { readonly ok: false; readonly error: EngineError };

interface LogRow {
  seq: number;
  at: number;
  type: string;
  tier: LogTier;
  key: string | null;
  run_id: string | null;
  caused_by: string | null;
  delta: string;
  view: string | null;
}

function toEntry(row: LogRow): StoredEntry {
  return {
    seq: row.seq,
    at: row.at,
    type: row.type,
    tier: row.tier,
    ...(row.key === null ? {} : { key: row.key as StoryKey }),
    ...(row.run_id === null ? {} : { run: row.run_id as RunId }),
    ...(row.caused_by === null ? {} : { causedBy: row.caused_by as RequestId }),
    delta: JSON.parse(row.delta) as unknown,
    ...(row.view === null ? {} : { view: JSON.parse(row.view) as unknown }),
  };
}

export interface ReplayOptions {
  /** At most this many entries; the caller continues from the last one returned. */
  readonly limit?: number;
}

/**
 * The entries of `office` with a seq above `after.seq`, in order, read in one deferred transaction
 * with the log head. A cursor of another stream or epoch, below the replay floor, or past the head
 * fails with `stream.resetRequired` and `details.oldest`.
 */
export function replay(
  office: OfficeHandle,
  after: Cursor,
  options: ReplayOptions = {},
): ReplayResult {
  return office.deferred(() => {
    const state = readLogState(office);
    const head = cursorAt(office.officeId, state.epoch, state.nextSeq - 1);
    const valid =
      after.stream === officeStream(office.officeId) &&
      after.epoch === state.epoch &&
      after.seq >= state.replayFloorSeq &&
      after.seq <= head.seq;
    if (!valid) {
      const oldest = cursorAt(office.officeId, state.epoch, state.replayFloorSeq);
      return {
        ok: false,
        error: engineError(
          "stream.resetRequired",
          "This cursor can no longer be replayed; take a new snapshot and subscribe after it.",
          { oldest },
        ),
      };
    }
    const limit = options.limit ?? -1;
    const rows = office.all<LogRow>(
      `select seq, at, type, tier, key, run_id, caused_by, delta, view from change_log
        where office_id = $office_id and seq > $after order by seq limit $limit`,
      { after: after.seq, limit },
    );
    return { ok: true, entries: rows.map(toEntry), head };
  });
}
