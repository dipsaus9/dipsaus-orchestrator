// The review verdict (DIPO-146; 0019 sections 5 and 6): reviewer reports validated by code, the
// verdict computed from them, and verdicts stored as review gates keyed on the code tree key.

export { REVIEW_COMMENT_MAX, redactComment, reviewComment } from "./comment";
export type { CommentFacts } from "./comment";
export { parseStoryDiff } from "./diff";
export type { DiffFile, StoryDiff } from "./diff";
export {
  recordReviewCommentUrl,
  recordReviewOverride,
  recordReviewVerdict,
  latestVerdictOfRun,
  reviewDecidedEntry,
  reviewerEffort,
  uncommentedVerdicts,
  reviewSummary,
  reviewVerdictForTree,
  reviewVerdictOfGate,
  reviewVerdictsOf,
  reviewVerdictView,
} from "./store";
export type { NewReviewVerdict, StoredReviewVerdict } from "./store";
export { BLOCKING_KINDS, evidenceProblems, validateReport } from "./validate";
export type { CheckedFinding, FindingCheck, ReportCheck, ReviewFacts } from "./validate";
export { findingCounts, judgeReview } from "./verdict";
export type { JudgedReview, ReviewDecision } from "./verdict";
