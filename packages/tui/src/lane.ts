// The planning lane's work in progress as words (DIPO-481, 0009): what the Floor's BACKLOG line,
// the Desk's queued line and the Plan view's filing line say about the changes dipo has queued for
// the backlog and the backlog PR they wait on. Pure functions of the `LaneProgress` the engine
// sent; nothing here derives a state.

import type { LaneOpView, LaneProgress, LanePrView } from "@dipsaus-orchestrator/contract";

/** The PR's CI state in words; `unknown` (not read, or none required) says nothing. */
export function ciWords(pr: LanePrView): string | null {
  if (pr.merged) return "merged";
  switch (pr.ci) {
    case "running":
      return "CI running";
    case "passed":
      return "CI passed";
    case "failed":
      return "CI failed";
    case "unknown":
      return null;
  }
}

/** `backlog PR #656, CI running`: the PR the changes wait on; `the next backlog PR` before one opened. */
export function waitsOn(lane: LaneProgress | null): string {
  const pr = lane?.pr;
  if (pr === undefined) return "the next backlog PR";
  const ci = ciWords(pr);
  return `backlog PR #${pr.number}${ci === null ? "" : `, ${ci}`}`;
}

/** `2 changes wait for backlog PR #656 · CI running` and the PR's CI role, for the Floor's BACKLOG line. */
export function backlogText(
  lane: LaneProgress,
  dot: string,
): { readonly text: string; readonly failed: boolean } {
  const n = lane.ops.length;
  const pr = lane.pr;
  const head = `${n === 1 ? "1 change waits" : `${n} changes wait`} for ${pr === undefined ? "the next backlog PR" : `backlog PR #${pr.number}`}`;
  const ci = pr === undefined ? null : ciWords(pr);
  return { text: ci === null ? head : `${head} ${dot} ${ci}`, failed: pr?.ci === "failed" };
}

/** How far an open change got, in words. */
export function opStateWords(state: LaneOpView["state"]): string {
  switch (state) {
    case "queued":
      return "queued";
    case "branch":
      return "on the branch";
    case "pr":
      return "in the PR";
  }
}
