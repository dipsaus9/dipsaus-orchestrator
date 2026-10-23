// The final summary of the close-out commit (0019 section 9 step 1, 0020 section 13). When a story
// PR's turn in the merge slot comes, the close-out commit on the story branch sets the final
// summary, the modified files and status `Done`. This is its summary step: the text is built from
// the story's stored facts (`run/summary.ts`) and written with `task edit --final-summary` in
// dipo's own copy of the story's backlog, inside the office git queue the caller holds.
//
// The story merge slot's close-out commit itself is DIPO-150's (`gitStorySlotOps.closeOut` in
// `story-git.ts`); it calls `writeCloseOutSummary` in the same `editInStoryBacklog` edit that sets
// `Done`, so the summary lands in that one commit.

import type { StoryTarget } from "../backlog/fields/write";
import { setFinalSummary } from "../backlog/fields/summary";
import type { OfficeHandle } from "../db/office";
import { finalSummaryOf } from "../run/summary";

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
