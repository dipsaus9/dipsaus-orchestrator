// The office change log (0005, 0007): an outbox of stored entries, one
// per fact, appended in the same transaction as the fact. Seq is gap-free per office because
// `offices.next_seq` advances in that transaction too, so a rollback consumes no seq.

import {
  type Cursor,
  findEvent,
  type RequestId,
  type RunId,
  type StoryKey,
} from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { cursorAt } from "./cursor";
import { renderProblem } from "./render";

export { cursorAt, officeStream } from "./cursor";

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
  readonly key?: StoryKey;
  readonly run?: RunId;
  readonly causedBy?: RequestId;
  readonly delta: unknown;
  readonly view?: unknown;
}

/** The office's log position (0007): the seq the next entry gets, so the last written entry has
 * `nextSeq - 1`. A new office starts at 1, so a cursor at seq 0 means "before anything". */
export interface LogState {
  readonly nextSeq: number;
}

/** The office's next seq; throws when the office has no row. */
export function readLogState(office: OfficeHandle): LogState {
  const row = office.get<{ next_seq: number }>(
    "select next_seq from offices where office_id = $office_id",
  );
  if (row === null) throw new Error(`Office ${office.officeId} has no offices row.`);
  return { nextSeq: row.next_seq };
}

/** The cursor of the last entry written (seq `nextSeq - 1`; 0 before the first entry). */
export function headCursor(office: OfficeHandle): Cursor {
  return cursorAt(office.officeId, readLogState(office).nextSeq - 1);
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

/** One entry as the `change_log` columns store it. */
interface EncodedEntry {
  readonly entry: NewEntry;
  readonly delta: string;
  readonly view: string | null;
}

/**
 * Encodes `entry` for storage and throws unless what is stored renders into a valid contract
 * event (DIPO-124): the check reads the stored JSON back, so it sees what replay will see.
 */
function encodeChecked(entry: NewEntry): EncodedEntry {
  assertOfficeFactType(entry.type);
  const delta = JSON.stringify(entry.delta ?? null);
  const view = entry.view === undefined ? null : JSON.stringify(entry.view);
  const problem = renderProblem({
    type: entry.type,
    delta: JSON.parse(delta) as unknown,
    ...(view === null ? {} : { view: JSON.parse(view) as unknown }),
  });
  if (problem !== undefined) {
    throw new Error(`A ${entry.type} change-log entry would not render: ${problem}.`);
  }
  return { entry, delta, view };
}

/**
 * Appends `entries` with consecutive seqs and advances `offices.next_seq`. Must run inside the
 * transaction that writes the facts. Every entry is checked before the first is written: one that
 * would not render throws, so the transaction rolls back and nothing is appended (DIPO-124).
 * Returns the cursor of the last entry, or undefined when there was nothing to append.
 */
export function appendEntries(
  office: OfficeHandle,
  entries: readonly NewEntry[],
  options: AppendOptions,
): Cursor | undefined {
  if (entries.length === 0) return undefined;
  const encoded = entries.map(encodeChecked);
  const state = readLogState(office);
  let seq = state.nextSeq;
  for (const { entry, delta, view } of encoded) {
    office.run(
      `insert into change_log (office_id, seq, at, type, key, run_id, caused_by, delta, view)
       values ($office_id, $seq, $at, $type, $key, $run, $caused_by, $delta, $view)`,
      {
        seq,
        at: options.at,
        type: entry.type,
        key: entry.key ?? null,
        run: entry.run ?? null,
        caused_by: options.causedBy ?? null,
        delta,
        view,
      },
    );
    seq += 1;
  }
  office.run("update offices set next_seq = $next where office_id = $office_id", { next: seq });
  return cursorAt(office.officeId, seq - 1);
}
