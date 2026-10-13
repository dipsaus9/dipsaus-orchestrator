// The backlog PR (DIPO-35; 0010 section 2, lane b): opening and updating the office's one
// backlog-only PR, its structural check, and the stories a failed check on a merged PR blocks.

export { CHECK_RULES, checkBacklogPr, LANE_B_TRANSITIONS, stateOf } from "./check";
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
export { collectPrDiff, taskOfPath } from "./diff";
export { BacklogPrs, factsFor, PR_NOTICES } from "./feature";
export type { BacklogPrsDeps, PrWaiting, PrWaitingReason } from "./feature";
export { backlogCheckBlocked, backlogPrMergeable, findPr, openPrs } from "./records";
export type { BacklogCheckBlock, BacklogPrRecord, BacklogPrState, CheckState } from "./records";
export { MAX_SUBJECT, prBody, prSummary, prTitle, TITLE_PREFIX } from "./title";
