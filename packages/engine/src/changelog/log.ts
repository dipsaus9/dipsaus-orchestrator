// The office change log (0005 section 6, 0007 sections 3 and 4): an outbox of stored entries, one
// per fact, appended in the same transaction as the fact. Seq is gap-free per office because
// `offices.next_seq` advances in that transaction too, so a rollback consumes no seq.

import {
  type Cursor,
  findEvent,
  type OfficeId,
  type RequestId,
  type RunId,
  type StoryKey,
  StreamName,
} from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

/** Retention tier of an entry (0007 section 7): S state, R short. */
export type LogTier = "S" | "R";

/** Event types kept only for the short tier (0007 section 7); every other type is state. */
export const SHORT_TIER_TYPES: ReadonlySet<string> = new Set([
  "work.output",
  "work.progress",
  "usage.updated",
  "work.observed",
]);

export function tierOf(type: string): LogTier {
  return SHORT_TIER_TYPES.has(type) ? "R" : "S";
}

/** What a writer appends: the fact delta and the view it computed at that moment. */
export interface NewEntry {
  readonly type: string;
  readonly delta: unknown;
  readonly view?: unknown;
  readonly key?: StoryKey;
  readonly run?: RunId;
}

/** One stored entry, as replay returns it. */
export interface StoredEntry {
  readonly seq: number;
  readonly at: number;
  readonly type: string;
  readonly tier: LogTier;
  readonly key?: StoryKey;
  readonly run?: RunId;
  readonly causedBy?: RequestId;
  readonly delta: unknown;
  readonly view?: unknown;
}

/** The office's log position (0007 section 3). */
export interface LogState {
  readonly epoch: string;
  /** The seq the next entry gets; the last written entry has `nextSeq - 1`. */
  readonly nextSeq: number;
  /** Replay from a cursor below this seq needs a reset (0007 section 7). */
  readonly replayFloorSeq: number;
}

export type RandomFill = (bytes: Uint8Array) => void;

const cryptoFill: RandomFill = (bytes) => {
  crypto.getRandomValues(bytes);
};

/**
 * A new random epoch for an office's change log (0005 section 2). Each office gets one when it is
 * registered and a new one when its state is restored, so old cursors never match new positions.
 */
export function newEpoch(fill: RandomFill = cryptoFill): string {
  const bytes = new Uint8Array(16);
  fill(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The log columns of a new `offices` row: a random epoch, the first entry gets seq 1 (so a
 * cursor at seq 0 means "before anything"), and nothing has been trimmed yet.
 */
export function newLogState(fill?: RandomFill): LogState {
  return { epoch: newEpoch(fill), nextSeq: 1, replayFloorSeq: 0 };
}

export function officeStream(office: OfficeId): StreamName {
  return StreamName.parse(`office:${office}`);
}

export function cursorAt(office: OfficeId, epoch: string, seq: number): Cursor {
  return { stream: officeStream(office), epoch, seq };
}

interface OfficeLogRow {
  epoch: string;
  next_seq: number;
  replay_floor_seq: number;
}

/** The office's epoch, next seq and replay floor; throws when the office has no row. */
export function readLogState(office: OfficeHandle): LogState {
  const row = office.get<OfficeLogRow>(
    "select epoch, next_seq, replay_floor_seq from offices where office_id = $office_id",
  );
  if (row === null) throw new Error(`Office ${office.officeId} has no offices row.`);
  return { epoch: row.epoch, nextSeq: row.next_seq, replayFloorSeq: row.replay_floor_seq };
}

/** The cursor of the last entry written (seq `nextSeq - 1`; 0 before the first entry). */
export function headCursor(office: OfficeHandle): Cursor {
  const state = readLogState(office);
  return cursorAt(office.officeId, state.epoch, state.nextSeq - 1);
}

/** Throws unless `type` is a stored (not derived) event of the office stream. */
function assertOfficeFactType(type: string): void {
  const definition = findEvent(type);
  if (definition === undefined) throw new Error(`Unknown event type ${type}.`);
  if (definition.derived) throw new Error(`${type} is derived and never stored.`);
  if (definition.stream === "software") throw new Error(`${type} belongs to the software stream.`);
}

export interface AppendOptions {
  readonly at: number;
  readonly causedBy?: RequestId;
}

/**
 * Appends `entries` with consecutive seqs and advances `offices.next_seq`. Must run inside the
 * transaction that writes the facts. Returns the cursor of the last entry, or undefined when
 * there was nothing to append.
 */
export function appendEntries(
  office: OfficeHandle,
  entries: readonly NewEntry[],
  options: AppendOptions,
): Cursor | undefined {
  if (entries.length === 0) return undefined;
  for (const entry of entries) assertOfficeFactType(entry.type);
  const state = readLogState(office);
  let seq = state.nextSeq;
  for (const entry of entries) {
    office.run(
      `insert into change_log (office_id, seq, at, type, tier, key, run_id, caused_by, delta, view)
       values ($office_id, $seq, $at, $type, $tier, $key, $run, $caused_by, $delta, $view)`,
      {
        seq,
        at: options.at,
        type: entry.type,
        tier: tierOf(entry.type),
        key: entry.key ?? null,
        run: entry.run ?? null,
        caused_by: options.causedBy ?? null,
        delta: JSON.stringify(entry.delta ?? null),
        view: entry.view === undefined ? null : JSON.stringify(entry.view),
      },
    );
    seq += 1;
  }
  office.run("update offices set next_seq = $next where office_id = $office_id", { next: seq });
  return cursorAt(office.officeId, state.epoch, seq - 1);
}
