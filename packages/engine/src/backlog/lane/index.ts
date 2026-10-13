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
  OfficeLane,
  OP_TRAILER,
  statusPaths,
} from "./lane";
export type {
  BacklogLaneDeps,
  FlushReport,
  OfficeLaneOptions,
  Waiting,
  WaitingReason,
} from "./lane";
export { EDIT_KIND, EditTarget, editKind } from "./ops";
export type { ApplyContext, ApplyOutcome, LaneOpKind } from "./ops";
