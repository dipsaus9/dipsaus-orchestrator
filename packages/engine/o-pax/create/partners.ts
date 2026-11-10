// The engine's services that call one built after them (DIPO-318). `createEngine` builds the
// services in one written order; each call that goes back up that order goes through a partner,
// connected in `connectEngine` once every service exists. A call before that throws.

import type { BacklogLane } from "../backlog/lane/feature";
import type { AutoMerge } from "../merge/merger";
import type { StoryIndex } from "../stories/feature";
import { Partner } from "../wiring/partner";
import type { EngineRuns } from "./runs";

export interface EnginePartners {
  readonly runs: Partner<EngineRuns>;
  readonly autoMerge: Partner<AutoMerge>;
  readonly lane: Partner<BacklogLane>;
  readonly storyIndex: Partner<StoryIndex>;
}

export function enginePartners(): EnginePartners {
  return {
    runs: new Partner("the run services"),
    autoMerge: new Partner("the auto-merge"),
    lane: new Partner("the planning lane"),
    storyIndex: new Partner("the story index"),
  };
}

/**
 * The one connect step of the engine (DIPO-318): each edge of a cycle between two services,
 * connected once every service exists.
 */
export function connectEngine(
  partners: EnginePartners,
  services: {
    readonly runs: EngineRuns;
    readonly autoMerge: AutoMerge;
    readonly lane: BacklogLane;
    readonly storyIndex: StoryIndex;
  },
): void {
  // The story PRs, the adapter holds and the story planning -> the run services: the CI watch asks
  // whether a run is a box run (DIPO-299), a lifted adapter hold resumes the starts paused (0020)
  // and a story with a run parks through run control (DIPO-160), while the run services sync the
  // story PR after each In Review push (DIPO-144), take the adapter holds at each launch and resume
  // a park with no run through the story planning.
  partners.runs.connect(services.runs);
  // The story PRs, the planning lane and the run services -> the auto-merge: no park or lift
  // reaches a story branch while its PR has auto-merge on (0002), a lane flush kicks it and a
  // resumed story goes back to it, while it merges through the lane, the story PRs and the runs.
  partners.autoMerge.connect(services.autoMerge);
  // The backlog PRs -> the planning lane: the PR follows the lane's operations (DIPO-35), while
  // the lane opens or updates the PR after each flush.
  partners.lane.connect(services.lane);
  // The planning lane -> the story index: a merged hold or resume is read again from the base,
  // while the index reads stories the lane wrote, and its poll checks the backlog PR.
  partners.storyIndex.connect(services.storyIndex);
}
