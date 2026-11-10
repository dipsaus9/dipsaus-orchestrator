// Replay from a cursor (0005, 0007). A reconnecting client sends the last cursor it saw; the
// engine returns the stored entries after it, or `stream.resetRequired` with the oldest cursor it
// can still replay from when the cursor is older than the oldest stored entry or beyond the last
// one. The oldest row decides: retention deletes old rows, and a lost database starts the log
// again, so a cursor of the old log is beyond the new one's last entry.

import {
  type Cursor,
  engineError,
  type EngineError,
  type RequestId,
  type RunId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

import { cursorAt, officeStream, readLogState, type StoredEntry } from "./log";

export type ReplayResult =
  | { readonly ok: true; readonly entries: readonly StoredEntry[]; readonly head: Cursor }
  | { readonly ok: false; readonly error: EngineError };

interface LogRow {
  seq: number;
  at: number;
  type: string;
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
 * with the log head. A cursor of another stream, older than the oldest stored entry, or past the
 * head fails with `stream.resetRequired` and `details.oldest`.
 */
export function replay(
  office: OfficeHandle,
  after: Cursor,
  options: ReplayOptions = {},
): ReplayResult {
  return office.deferred(() => {
    const head = cursorAt(office.officeId, readLogState(office).nextSeq - 1);
    // Replay after `oldest` is complete: every entry above it is still stored.
    const first = office.get<{ seq: number | null }>(
      "select min(seq) as seq from change_log where office_id = $office_id",
    )?.seq;
    const oldest = cursorAt(office.officeId, first == null ? head.seq : first - 1);
    const valid =
      after.stream === officeStream(office.officeId) &&
      after.seq >= oldest.seq &&
      after.seq <= head.seq;
    if (!valid) {
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
      `select seq, at, type, key, run_id, caused_by, delta, view from change_log
        where office_id = $office_id and seq > $after order by seq limit $limit`,
      { after: after.seq, limit },
    );
    return { ok: true, entries: rows.map(toEntry), head };
  });
}
