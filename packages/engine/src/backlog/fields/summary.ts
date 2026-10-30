// The structured summary on park, resume and close (0020 section 13, 0001): code-built text in
// Backlog's own implementation notes and final summary, written through the Backlog CLI
// (`task edit --append-notes`, `task edit --final-summary`) and read back. These are the native
// sections, not the `dipo` field block, so no schema changes. A text holding a line of 50 `-` is
// refused before the CLI runs (the runner's rule, 0010 section 2: Backlog.md would print it as a
// section); the builders in `records/summary.ts` never write one.
//
// Like `writeFields`, every call must go through the office git queue, in dipo's own copy of the
// story's backlog; the caller owns that.

import { hasSectionRule } from "../plain";
import { runBacklog } from "../runner";
import { FieldWriteError, type StoryTarget, viewStory } from "./write";

/** The CLI stores section text trimmed, with LF line endings; comparing also NFC-normalises. */
function comparable(text: string): string {
  return text.replace(/\r\n/g, "\n").normalize("NFC").trim();
}

function refuseRule(target: StoryTarget, text: string): void {
  if (hasSectionRule(text)) {
    throw new FieldWriteError(target.id, "the summary holds a line of 50 `-`");
  }
}

/**
 * Appends `text` as one block to the story's implementation notes and checks the notes read back
 * end with it. Returns the notes now stored.
 */
export async function appendImplementationNotes(
  target: StoryTarget,
  text: string,
): Promise<string> {
  refuseRule(target, text);
  await runBacklog(target.cli, target.cwd, [
    target.kind ?? "task",
    "edit",
    target.id,
    "--append-notes",
    text,
  ]);
  const notes = (await viewStory(target)).implementationNotes ?? "";
  if (!comparable(notes).endsWith(comparable(text))) {
    throw new FieldWriteError(
      target.id,
      "the implementation notes read back do not end with the block",
    );
  }
  return notes;
}

/** Sets the story's final summary to `text` and checks it reads back the same. */
export async function setFinalSummary(target: StoryTarget, text: string): Promise<string> {
  refuseRule(target, text);
  await runBacklog(target.cli, target.cwd, [
    target.kind ?? "task",
    "edit",
    target.id,
    "--final-summary",
    text,
  ]);
  const summary = (await viewStory(target)).finalSummary ?? "";
  if (comparable(summary) !== comparable(text)) {
    throw new FieldWriteError(
      target.id,
      "the final summary read back differs from the one written",
    );
  }
  return summary;
}
