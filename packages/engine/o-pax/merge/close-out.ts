// The close-out commit's story edits (0002, 0010 story lane, 0020). When a merge gate is approved,
// dipo commits the close-out on the story branch before it turns auto-merge on: the final summary,
// built from the story's stored facts as of the close-out (`records/summary.ts`), and status `Done`.
// A gate decided by rule closes out before CI ran on any head of it, so red checks on the close-out
// head start a fix round that sets the story In Progress again, and the next close-out replaces
// the final summary with one built from the facts then. A park record exists
// only while a story is Parked, so the same commit removes the `park` field, through the single
// field write path. The commit itself is `StoryMergeGit.closeOut` (`story-git.ts`), which runs these
// edits in one story lane edit of the StoryStore and commits the task file alone.

import type { OfficeHandle } from "../db/office";
import { GitError } from "../git/runner";
import { finalSummaryOf } from "../records/summary";
import type { StoryEditor } from "../story-store/store";

/** The status the close-out commit sets (0012). */
export const DONE_STATUS = "Done";

/** Sets the story's final summary from its stored facts as of `at`; returns the text written. */
export async function writeCloseOutSummary(
  story: StoryEditor,
  office: OfficeHandle,
  key: string,
  at: number,
): Promise<string> {
  const text = finalSummaryOf(office, key, at);
  await story.setFinalSummary(text);
  return text;
}

/**
 * Inside the close-out edit: the `park` field is removed through the single field write path, then
 * the status is set to `Done`. Throws a `GitError` when the store left another status.
 */
export async function closeOutFields(story: StoryEditor): Promise<void> {
  await story.writeFields((fields) => {
    const { park: _park, ...rest } = fields;
    return rest;
  });
  const before = await story.view();
  if (before.status !== DONE_STATUS) await story.setStatus(DONE_STATUS);
  const back = await story.view();
  if (back.status !== DONE_STATUS) {
    throw new GitError(
      "closeOut.statusNotWritten",
      `The Backlog CLI left ${story.id} at ${back.status}, not ${DONE_STATUS}.`,
    );
  }
}
