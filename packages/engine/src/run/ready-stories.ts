// The one function that sets Refined stories on the base Ready (0012, DIPO-451, DIPO-482):
// the planning confirm (for the story it files) and `story.ready` (any Refined story the office has
// on the base) both call it. For each story it
// evaluates the Ready gate against the story as the base branch holds it and stores the decision;
// a story that passes is set Ready through the planning lane, in a backlog PR other than the one
// that filed it; a story that fails stays as it is with the gate's messages. What the caller
// chooses is the caller's own rule. The maintainer's planning confirm files a story Ready itself
// (DIPO-495): its lane operation runs the same evaluation and store
// (`GateStore.recordLaneDecision`) on the story as filed.

import type { StoryKey } from "@dipsaus-orchestrator/contract";

import { CommandError } from "../commands/errors";
import type { OfficeHandle } from "../db/office";
import type { GateStore } from "../gate-decisions";
import { PlanningRefusedError } from "../story-store/errors";
import { type PlannedChange, type PlanningLane, REVISE_KIND } from "../story-store/planning";

/** The part of the Ready gate setting Ready uses. */
export type PlanningGate = Pick<GateStore, "recordGateDecision">;

/** A story to set Ready; `key` is null for one whose filing PR has not merged (no key yet). */
export interface ReadyIdentity {
  readonly story: string;
  readonly key: StoryKey | null;
}

export interface ReadyOutcome {
  readonly change?: PlannedChange;
  readonly messages: string[];
}

export interface ReadyStoriesDeps {
  readonly office: OfficeHandle;
  readonly lane: PlanningLane;
  readonly gate: PlanningGate;
}

export interface ReadyBatch {
  readonly queued: string[];
  readonly refused: { story: string; messages: string[] }[];
  /** The last change journaled: the caller flushes the lane with it. */
  readonly last: PlannedChange | undefined;
}

/** The gate for one story and, when it passes, the lane change that sets it Ready. */
export async function readyStory(
  deps: ReadyStoriesDeps,
  identity: ReadyIdentity,
): Promise<ReadyOutcome> {
  const { office, lane, gate } = deps;
  const { key } = identity;
  const notFiledYet = `${identity.story} is not on the base branch yet; set it Ready once the backlog PR that filed it has merged`;
  if (key === null) return { messages: [notFiledYet] };
  if (lane.isOpen(key, REVISE_KIND)) {
    return {
      messages: ["an edit of it still waits for its backlog PR to merge; set it Ready after that"],
    };
  }
  let decision;
  try {
    decision = await gate.recordGateDecision(office.officeId, key, "ready");
  } catch (error) {
    if (!(error instanceof CommandError) || error.error.code !== "story.unknown") throw error;
    return { messages: [notFiledYet] };
  }
  if (!decision.result.passed) {
    return {
      messages: decision.result.failures.map((failure) => `${failure.rule}: ${failure.message}`),
    };
  }
  try {
    return { change: await lane.setReady({ key, story: identity.story }), messages: [] };
  } catch (error) {
    if (!(error instanceof PlanningRefusedError)) throw error;
    return { messages: [error.message] };
  }
}

/**
 * Each distinct story in turn. `settled` names a story set already, which counts as queued with no
 * new change; `record` sees every outcome as it comes.
 */
export async function readyStories(
  deps: ReadyStoriesDeps,
  identities: readonly ReadyIdentity[],
  hooks: {
    readonly settled?: (identity: ReadyIdentity) => boolean;
    readonly record?: (identity: ReadyIdentity, outcome: ReadyOutcome) => void;
  } = {},
): Promise<ReadyBatch> {
  const queued: string[] = [];
  const refused: ReadyBatch["refused"] = [];
  let last: PlannedChange | undefined;
  const seen = new Set<string>();
  for (const identity of identities) {
    if (seen.has(identity.story)) continue;
    seen.add(identity.story);
    if (hooks.settled?.(identity) === true) {
      queued.push(identity.story);
      continue;
    }
    const outcome = await readyStory(deps, identity);
    hooks.record?.(identity, outcome);
    if (outcome.change === undefined) {
      refused.push({ story: identity.story, messages: outcome.messages });
    } else {
      queued.push(identity.story);
      last = outcome.change;
    }
  }
  return { queued, refused, last };
}
