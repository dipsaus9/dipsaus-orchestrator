// The office merge slot (DIPO-73; 0016 rule 2, 0010 section 7): backlog PRs merge through it in M0.

export { checksFinal, evaluateChecks, REQUIRED_CHECKS, requiredCheckStates } from "./checks";
export type { RequiredCheckState, ChecksVerdict } from "./checks";
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
export { writeCloseOutSummary } from "./close-out";
// The close-out commit's park record and status (DIPO-155, for DIPO-150's story merge slot).
export { closeOutFields, DONE_STATUS, gitCloseOutWriter } from "./close-out-park";
export type { CloseOutRequest, CloseOutWriter } from "./close-out-park";
