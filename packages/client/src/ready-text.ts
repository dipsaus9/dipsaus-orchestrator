// What `story.ready` answered, in plain words, for every client (DIPO-482): one line per story, set
// or refused, and for a set one the backlog PR it waits on, from the lane's progress (DIPO-492): the
// command answers once the change is journaled, before the lane flushes it, so the PR is not in the
// result. The CLI and the TUI both read it here, so the two say the same.

import type { LaneProgress } from "@dipsaus-orchestrator/contract";

/** The shape of a `story.ready` or `planning.ready` result. */
export interface ReadyResult {
  readonly queued: readonly string[];
  readonly refused: readonly { readonly story: string; readonly messages: readonly string[] }[];
}

export interface ReadyLine {
  readonly story: string;
  readonly state: "queued" | "refused";
  readonly text: string;
}

/** Where a set story waits: the backlog PR the lane reports, or that it has none yet. */
export function readyWaitingText(lane: LaneProgress | null | undefined): string {
  const pr = lane?.pr;
  if (pr === undefined) return "queued: waits for its backlog PR";
  return pr.merged ? "Ready: its backlog PR merged" : `waiting for the backlog PR #${pr.number}`;
}

/** One line per story: those set first, in the order the engine answered, then those refused. */
export function readyLines(
  result: ReadyResult,
  lane: LaneProgress | null | undefined = null,
): ReadyLine[] {
  return [
    ...result.queued.map((story): ReadyLine => ({
      story,
      state: "queued",
      text: readyWaitingText(lane),
    })),
    ...result.refused.map((item): ReadyLine => ({
      story: item.story,
      state: "refused",
      text: item.messages.join("; ") || "refused",
    })),
  ];
}
