// The close-out commit's task file edits (0002, 0010 story lane, 0020). When a merge gate is
// approved, dipo commits the close-out on the story branch before it turns auto-merge on: the final
// summary, built from the story's stored facts (`run/summary.ts`), and status `Done`. A park record
// exists only while a story is Parked, so the same commit removes the `park` field, through the
// single field write path. The commit itself is `StoryMergeGit.closeOut` (`story-git.ts`), which
// runs these edits in dipo's own copy of the story's backlog and commits the task file alone.

import type { StoryTarget } from "../backlog/fields/write";
import { setFinalSummary } from "../backlog/fields/summary";
import { viewStory, writeFields } from "../backlog/fields/write";
import { runBacklog } from "../backlog/runner";
import type { OfficeHandle } from "../db/office";
import { GitError } from "../git/runner";
import { finalSummaryOf } from "../run/summary";

/** The status the close-out commit sets (0012). */
export const DONE_STATUS = "Done";

/** Sets the story's final summary from its stored facts as of `at`; returns the text written. */
export async function writeCloseOutSummary(
  target: StoryTarget,
  office: OfficeHandle,
  key: string,
  at: number,
): Promise<string> {
  const text = finalSummaryOf(office, key, at);
  await setFinalSummary(target, text);
  return text;
}

/**
 * Inside the close-out edit, in dipo's own copy of the story's backlog: the `park` field is removed
 * through the single field write path, then the status is set to `Done`. Throws a `GitError` when
 * the CLI left another status.
 */
export async function closeOutFields(target: StoryTarget): Promise<void> {
  await writeFields(target, (fields) => {
    const { park: _park, ...rest } = fields;
    return rest;
  });
  const before = await viewStory(target);
  if (before.status !== DONE_STATUS) {
    await runBacklog(target.cli, target.cwd, ["task", "edit", target.id, "--status", DONE_STATUS]);
  }
  const back = await viewStory(target);
  if (back.status !== DONE_STATUS) {
    throw new GitError(
      "closeOut.statusNotWritten",
      `The Backlog CLI left ${target.id} at ${back.status}, not ${DONE_STATUS}.`,
    );
  }
}
