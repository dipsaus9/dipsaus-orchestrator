// What `story.ready` answered, in plain words, for every client (DIPO-482): one line per story, set
// or refused, and for a set one the backlog PR it waits on, from the flush of the lane's change.
// The CLI and the TUI both read it here, so the two say the same.

import type { LaneFlush } from "@dipsaus-orchestrator/contract";

/** The shape of a `story.ready` result. */
export interface ReadyResult {
  readonly queued: readonly string[];
  readonly refused: readonly { readonly story: string; readonly messages: readonly string[] }[];
  readonly flush?: LaneFlush | undefined;
}

export interface ReadyLine {
  readonly story: string;
  readonly state: "queued" | "refused";
  readonly text: string;
}

/** Where a set story waits: the backlog PR it is in, or why it does not have one yet. */
export function readyWaitingText(flush: LaneFlush | undefined): string {
  if (flush === undefined) return "set Ready once its backlog PR merges";
  switch (flush.state) {
    case "opened":
    case "updated":
      return `waiting for the backlog PR ${flush.pr}`;
    case "pushed":
      return `waiting for its backlog PR (pushed on ${flush.branch}, not open yet)`;
    case "merged":
      return "Ready: its backlog PR merged";
    case "held":
      return `held on ${flush.branch}: ${flush.reason}`;
    case "waiting":
      return `waiting for the next backlog PR: ${flush.reason}`;
    case "failed":
      return `not written yet, it stays journaled: ${flush.reason}`;
    case "closed":
      return `not set: ${flush.reason}`;
  }
}

/** One line per story: those set first, in the order the engine answered, then those refused. */
export function readyLines(result: ReadyResult): ReadyLine[] {
  return [
    ...result.queued.map((story): ReadyLine => ({
      story,
      state: "queued",
      text: readyWaitingText(result.flush),
    })),
    ...result.refused.map((item): ReadyLine => ({
      story: item.story,
      state: "refused",
      text: item.messages.join("; ") || "refused",
    })),
  ];
}
