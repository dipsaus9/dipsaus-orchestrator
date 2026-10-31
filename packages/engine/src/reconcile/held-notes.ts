// A decision note the decision record on `_base` already holds (DIPO-404; 0020): the record is the
// answer, so the note closes itself with a notice. Reconcile reads each open note's file at the
// base and closes the note when its exact text is under the section it names (`noteHeld`). A note
// whose file, section or text does not match stays open. dipo never writes the record.

import { dismissNote, openNotes } from "../run/proposals";
import { noteHeld } from "../run/report-data";

import type { ReconcileDeps, ReconcileFinding } from "./reconcile";

/** The notice code of a note closed here (DIPO-404). */
export const HELD_NOTE_NOTICE = "reconcile.decisionNoteHeld";

type Recorder = (finding: ReconcileFinding, facts?: () => void, level?: "info" | "warn") => void;

/** The text of `file` at the base, or null when the base has no such file or cannot be read. */
async function fileAtBase(deps: ReconcileDeps, base: string, file: string): Promise<string | null> {
  return deps.git
    .run(async (session) => {
      const shown = await session.step(session.repository, ["show", `${base}:${file}`]);
      return shown.code === 0 ? shown.stdout : null;
    })
    .catch(() => null);
}

/** Closes each open decision note that the decision record on the base already holds. */
export async function closeHeldNotes(deps: ReconcileDeps, record: Recorder): Promise<void> {
  const notes = openNotes(deps.office);
  if (notes.length === 0) return;
  const base = await deps.git.resolveBase().catch(() => null);
  if (base === null) return;
  for (const note of notes) {
    const text = await fileAtBase(deps, base, note.file);
    if (!noteHeld(note, text)) continue;
    record(
      {
        code: HELD_NOTE_NOTICE,
        key: note.key,
        text: `The decision note for ${note.file}, section "${note.section}", is already in that record on ${base}; dipo closed it.`,
      },
      () => dismissNote(deps.office, note, deps.clock.now()),
    );
  }
}
