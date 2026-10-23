// The planning lane (DIPO-34; 0010 section 2, lane b): the journal, operation kinds, the per-office
// lane and its replay load step.

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
  LANE_WORKTREE,
  LaneError,
  LaneFlushError,
  OfficeLane,
  OP_TRAILER,
  statusPaths,
} from "./lane";
export type {
  BacklogLaneDeps,
  BaseRef,
  FlushReport,
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
export {
  markedStory,
  PROPOSAL_MARKER,
  PROPOSE_KIND,
  ProposeTarget,
  proposeKind,
  recordDraftId,
} from "./propose";
