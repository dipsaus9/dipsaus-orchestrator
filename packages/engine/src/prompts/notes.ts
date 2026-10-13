// Worker notes for a next session (0014 sections 2 and 6, 0007 section 4): the `notes` of a
// worker report, the only model-written part of a handoff, stored per worktree and agent at most
// 1,500 characters. The newest notes of a worktree go into the next handoff block. Teardown
// (DIPO-58) deletes them with `forgetWorkerNotes`.

import type { Clock } from "@dipsaus-orchestrator/contract";

import { formatCount } from "../context/truncate";
import type { OfficeHandle } from "../db/office";

/** Notes are at most this many characters (0014 section 2). */
export const WORKER_NOTES_MAX = 1_500;

const notesMarker = (shown: number, total: number): string =>
  `[dipo: notes cut, showing ${formatCount(shown)} of ${formatCount(total)} characters.]`;

/**
 * `notes` with at most `WORKER_NOTES_MAX` characters: longer notes keep their head, cut at the
 * last line break that fits (or mid-line when the first line alone is too long), plus a marker.
 */
export function capNotes(notes: string): string {
  const text = notes.replace(/\r\n?/g, "\n").trim();
  if (text.length <= WORKER_NOTES_MAX) return text;
  const room = WORKER_NOTES_MAX - notesMarker(text.length, text.length).length - 1;
  let head = text.slice(0, room);
  const lineEnd = head.lastIndexOf("\n");
  if (lineEnd > 0) head = head.slice(0, lineEnd);
  // Never leave half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  head = head.trimEnd();
  return `${head}\n${notesMarker(head.length, text.length)}`;
}

export interface WorkerNotes {
  /** Absolute worktree path. */
  readonly worktree: string;
  readonly run: string;
  readonly agent: string;
  readonly role: string;
  /** The story key (`sto_...`), when the run has one. */
  readonly storyKey?: string;
  /** The report's notes, cut to `WORKER_NOTES_MAX`. */
  readonly text: string;
  readonly recordedAt: number;
}

export interface RecordWorkerNotesInput {
  readonly worktree: string;
  readonly run: string;
  readonly agent: string;
  readonly role: string;
  readonly storyKey?: string;
  /** The `notes` field of the worker report; nothing is stored when it is empty. */
  readonly notes: string | undefined;
}

/** Stores a report's notes for the worktree, replacing the agent's earlier notes. */
export function recordWorkerNotes(
  office: OfficeHandle,
  input: RecordWorkerNotesInput,
  clock: Clock,
): WorkerNotes | null {
  const notes = input.notes?.trim() ?? "";
  if (notes === "") return null;
  const record: WorkerNotes = {
    worktree: input.worktree,
    run: input.run,
    agent: input.agent,
    role: input.role,
    ...(input.storyKey === undefined ? {} : { storyKey: input.storyKey }),
    text: capNotes(notes),
    recordedAt: clock.now(),
  };
  office.immediate(() =>
    office.run(
      `insert into worker_notes (office_id, worktree, agent_id, run_id, story_key, role, text, recorded_at)
       values ($office_id, $worktree, $agent, $run, $key, $role, $text, $at)
       on conflict (office_id, worktree, agent_id) do update set
         run_id = excluded.run_id, story_key = excluded.story_key, role = excluded.role,
         text = excluded.text, recorded_at = excluded.recorded_at`,
      {
        worktree: record.worktree,
        agent: record.agent,
        run: record.run,
        key: record.storyKey ?? null,
        role: record.role,
        text: record.text,
        at: record.recordedAt,
      },
    ),
  );
  return record;
}

interface WorkerNotesRow {
  readonly worktree: string;
  readonly agent_id: string;
  readonly run_id: string;
  readonly story_key: string | null;
  readonly role: string;
  readonly text: string;
  readonly recorded_at: number;
}

/** The newest notes stored for `worktree`, or null. */
export function latestWorkerNotes(office: OfficeHandle, worktree: string): WorkerNotes | null {
  const row = office.get<WorkerNotesRow>(
    `select * from worker_notes where office_id = $office_id and worktree = $worktree
     order by recorded_at desc, agent_id desc limit 1`,
    { worktree },
  );
  if (row === null) return null;
  return {
    worktree: row.worktree,
    run: row.run_id,
    agent: row.agent_id,
    role: row.role,
    ...(row.story_key === null ? {} : { storyKey: row.story_key }),
    text: row.text,
    recordedAt: row.recorded_at,
  };
}

/** Deletes the worktree's notes at teardown (0007 retention tier T). */
export function forgetWorkerNotes(office: OfficeHandle, worktree: string): void {
  office.immediate(() =>
    office.run("delete from worker_notes where office_id = $office_id and worktree = $worktree", {
      worktree,
    }),
  );
}
