// The office merge slot (DIPO-73; 0016 rule 2, 0010 section 7): backlog PRs since M0 and story PRs
// since DIPO-150 (0019 sections 9 and 11), with the merge gates in front of a story PR's entry.

export { checksFinal, evaluateChecks, REQUIRED_CHECKS, requiredCheckStates } from "./checks";
export type { RequiredCheckState, ChecksVerdict } from "./checks";
export { writeCloseOutSummary } from "./close-out";
export { MergeGates } from "./commands";
export type { MergeGatesDeps } from "./commands";
export {
  AUTORELEASE_LABEL,
  autoreleasePending,
  decideMergeGate,
  decideOnHandMerge,
  HAND_MERGE_NOTE,
  holdLabelsOn,
  MERGE_GATE_KIND,
  mergeGate,
  mergeGatesOfRun,
  mergeGateSummary,
  mergeWaits,
  openMaintainerMergeGate,
  openMergeGate,
  overrideGateOf,
  overrideGateSummary,
} from "./gates";
export type { MergeWait, StoredMergeGate } from "./gates";
export { laneSlotGit } from "./git";
export type { BaseSync, PushOutcome, SlotGit } from "./git";
export {
  CHECKS_WAIT_MS,
  MAX_MERGE_ATTEMPTS,
  MERGE_SLOT_STEP,
  MergeSlot,
  SLOT_NOTICES,
} from "./slot";
export type { MergeSlotDeps, SlotOutcome } from "./slot";
export { enterSlot, leaveSlot, runInSlot, slotOccupant, updateSlot } from "./store";
export type { SlotOccupant, SlotPhase, SlotSyncMode } from "./store";
export { gitStorySlotOps } from "./story-git";
export type { StorySlotGit, StorySlotRun, StorySync } from "./story-git";
export { STORY_MERGE_ATTEMPTS, STORY_SLOT_NOTICES, StorySlot } from "./story-slot";
export type { StoryCandidate, StorySlotContext, StorySlotDeps } from "./story-slot";
// The close-out commit's park record and status (DIPO-155, for DIPO-150's story merge slot).
export { closeOutFields, DONE_STATUS, gitCloseOutWriter } from "./close-out-park";
export type { CloseOutRequest, CloseOutWriter } from "./close-out-park";
