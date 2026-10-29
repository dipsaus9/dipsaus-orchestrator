// The backlog PR (DIPO-35; 0010 section 2, lane b): opening and updating the office's one
// backlog-only PR, its structural check, the stories a failed check on a merged PR blocks, and its
// auto-merge (0002).

export {
  ADDED_OUTSIDE_BACKLOG,
  CHECK_RULES,
  checkBacklogPr,
  LANE_B_TRANSITIONS,
  stateOf,
} from "./check";
export type {
  CheckFailure,
  CheckResult,
  CheckRule,
  ParsedView,
  PrDiff,
  PrFacts,
  TaskChange,
  TaskSide,
} from "./check";
export { backlogPrDeskItems } from "./desk";
export { collectPrDiff, RestoreError, taskOfPath } from "./diff";
export { BacklogPrs, factsFor, PR_NOTICES, repoOfUrl } from "./feature";
export type { AdoptReport, BacklogPrsDeps, PrWaiting, PrWaitingReason } from "./feature";
export { BACKLOG_MERGE_NOTICES, BacklogMerges } from "./merge";
export type { BacklogMergeContext, BacklogMergeDeps } from "./merge";
export { laneMergeGit } from "./merge-git";
export type { BacklogMergeGit } from "./merge-git";
export { placeBranch, readBranch } from "./adopt";
export type { AdoptableBranch, BranchOp, BranchReading, BranchToRead } from "./adopt";
export { backlogCheckBlocked, backlogPrMergeable, findPr, openPrs } from "./records";
export type { BacklogCheckBlock, BacklogPrRecord, BacklogPrState, CheckState } from "./records";
export { MAX_SUBJECT, prBody, prSummary, prTitle, TITLE_PREFIX } from "./title";
