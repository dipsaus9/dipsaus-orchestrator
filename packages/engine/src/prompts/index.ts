// Worker prompt assembly (0014, DIPO-47): the L1+L2 system file, the `implement` task message,
// verify feedback items, the handoff block, worker notes and prompt part measurements; the
// `review` system file and task message (0019 section 4).

export { assembleTaskMessage, taskBudgetsFor } from "./assemble";
export type { Drop, TaskBudgets, TaskMessage, TaskMessageInput } from "./assemble";
export {
  BASE_VERIFY_MAX_NAMES,
  BASE_VERIFY_UNKNOWN,
  renderBaseVerify,
  type BaseVerifyFacts,
} from "./base-verify";
export {
  assembleContract,
  CONTRACT_MAX_DEFAULT,
  CONTRACT_SECTIONS,
  CONTRACT_TOO_LARGE,
  contractSize,
  ContractTooLargeError,
  SECTION_ORDER,
} from "./contract";
export type { Section, SectionName } from "./contract";
export {
  FEEDBACK_LOCATIONS_MAX,
  FEEDBACK_LOG_LINES_DEFAULT,
  ciFeedback,
  parseActionsLog,
  parseLocations,
  plainOutput,
  verifyFeedback,
} from "./feedback";
export type {
  CiFailure,
  CiFeedbackItem,
  FeedbackItem,
  SourceLocation,
  VerifyFailure,
  VerifyFeedbackItem,
  VerifyFeedbackOptions,
} from "./feedback";
export {
  BOX_CHANGES,
  BOX_VERIFY,
  gatherHandoff,
  HANDOFF_BUDGET_DEFAULT,
  renderHandoff,
} from "./handoff";
export type { GatherHandoffOptions, HandoffFacts, HandoffFeedback, LastVerify } from "./handoff";
export {
  capNotes,
  forgetWorkerNotes,
  latestWorkerNotes,
  recordWorkerNotes,
  WORKER_NOTES_MAX,
} from "./notes";
export type { RecordWorkerNotesInput, WorkerNotes } from "./notes";
export {
  CHARS_PER_TOKEN,
  measurePart,
  promptParts,
  promptPartsOf,
  recordPromptParts,
  SYSTEM_PART,
  TASK_PART,
} from "./parts";
export type { PromptPart } from "./parts";
export { backgroundOf, outcomeOf, promptStoryOf } from "./story";
export type { PromptCriterion, PromptDependency, PromptStory, PromptStoryOptions } from "./story";
export {
  assembleReviewTaskMessage,
  REVIEW_SECTION_ORDER,
  reviewCommitSection,
  type ReviewChangedPath,
  type ReviewCommitCopy,
  type ReviewSection,
  type ReviewSectionName,
  type ReviewTaskInput,
  type ReviewTaskMessage,
  withReviewCommit,
} from "./review";
export { renderSystemFile } from "./system";
export {
  CONTRACT_TEMPLATES,
  FEEDBACK_TEMPLATES,
  renderTemplate,
  ROLE_TEMPLATES,
  slotsOf,
  TASK_TEMPLATES,
  templateProblems,
  neutraliseTags,
  PROMPT_TAGS,
  rendered,
} from "./templates";
export type { BuiltInRole, ContractKind, Rendered } from "./templates";
