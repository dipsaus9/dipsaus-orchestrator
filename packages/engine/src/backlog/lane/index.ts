// The planning lane (DIPO-34; 0010 section 2, lane b): the journal, operation kinds, the per-office
// lane and its replay load step.

export { failedHoldDeskItems, laneDeskItems, PLANNING_LANE_DESK } from "./desk";
export { BacklogLane } from "./feature";
export {
  allEntries,
  findEntry,
  OPEN_STATES,
  PENDING_LANE_NOTICE,
  pendingLaneOp,
  recordPrRef,
} from "./journal";
export type { JournalEntry, JournalState, LaneOp, PendingLaneOp } from "./journal";
export {
  LANE_BRANCH_PREFIX,
  LANE_NOTICES,
  LANE_REPLAY_STEP,
  LANE_STUCK_MS,
  LANE_WORKTREE,
  LaneError,
  LaneFlushError,
  OfficeLane,
  OP_TRAILER,
} from "./lane";
export type {
  BacklogLaneDeps,
  BaseRef,
  FlushReport,
  LaneStall,
  OfficeLaneOptions,
  Waiting,
  WaitingReason,
} from "./lane";
export {
  DISCARD_KIND,
  DROP_KIND,
  DropTarget,
  dropKind,
  EDIT_KIND,
  EditTarget,
  editKind,
  HOLD_KIND,
  RESUME_KIND,
} from "./ops";
export type { ApplyContext, ApplyOutcome, LaneOpKind } from "./ops";
export { DISCARDABLE_STATUSES, discardOp, PARKABLE_STATUSES, planningLane } from "./planning";
export {
  filedDraft,
  markedDrafts,
  PROPOSAL_MARKER,
  PROPOSE_KIND,
  ProposeTarget,
  proposeKind,
  proposeTarget,
  recordDraftId,
} from "./propose";
