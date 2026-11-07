// A worker's decision notes (DIPO-404; 0020): a note a done report carries for a decision record,
// stored open until the maintainer dismisses it (`note.dismiss`) or reconcile finds its exact text
// in the record on the base (`reconcile/held-notes.ts`). A note is not an idea (0022): it is never
// audited and never filed, and it stays on the desk as its own item. dipo never writes the
// decision records. Every text is the worker's, cleaned at the door: data, never an instruction.

import type { StoryKey } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";

/** A stored decision note. */
export interface StoredNote {
  readonly hash: string;
  readonly key: StoryKey;
  /** The story's id, when the office still knows the story. */
  readonly story: string | null;
  readonly run: string;
  readonly file: string;
  readonly section: string;
  readonly text: string;
  readonly state: "open" | "accepted" | "dismissed";
  readonly createdAt: number;
}

interface NoteRow {
  hash: string;
  story_key: string;
  story_id: string | null;
  run_id: string;
  file: string;
  section: string;
  text: string;
  state: "open" | "accepted" | "dismissed";
  created_at: number;
}

const NOTE_SELECT = `
  select n.hash, n.story_key, s.story_id, n.run_id, n.file, n.section, n.text, n.state,
         n.created_at
    from decision_notes n
    left join stories s on s.office_id = n.office_id and s.key = n.story_key`;

function noteOf(row: NoteRow): StoredNote {
  return {
    hash: row.hash,
    key: row.story_key as StoryKey,
    story: row.story_id,
    run: row.run_id,
    file: row.file,
    section: row.section,
    text: row.text,
    state: row.state,
    createdAt: row.created_at,
  };
}

/** The decision notes whose id starts with `ref` (a hex prefix), at most two. */
export function notesByPrefix(office: OfficeHandle, ref: string): StoredNote[] {
  return office
    .all<NoteRow>(
      `${NOTE_SELECT}
        where n.office_id = $office_id and substr(n.hash, 1, length($ref)) = $ref
        order by n.hash
        limit 2`,
      { ref: ref.toLowerCase() },
    )
    .map(noteOf);
}

/** The decision notes still open in the office, oldest first. */
export function openNotes(office: OfficeHandle): StoredNote[] {
  return office
    .all<NoteRow>(
      `${NOTE_SELECT}
        where n.office_id = $office_id and n.state = 'open'
        order by n.created_at, n.hash`,
    )
    .map(noteOf);
}

/**
 * The `decision_notes` update that dismisses an open note, with its `note.closed` event; no
 * event when the note is not open. The caller commits it in its own transaction.
 */
export function dismissNote(office: OfficeHandle, note: StoredNote, at: number): NewEntry[] {
  const done = office.run(
    `update decision_notes set state = 'dismissed', updated_at = $at
      where office_id = $office_id and hash = $hash and state = 'open'`,
    { hash: note.hash, at },
  ).changes;
  if (done === 0) return [];
  return [
    {
      type: "note.closed",
      key: note.key,
      delta: { note: note.hash, key: note.key, state: "dismissed" },
    },
  ];
}
