// The hook relay's engine side (0008 section 5, DIPO-59): neutral hook events and replies, the
// `questions` table and the permission wait with `work.answer`; the 0014 section 8 nudges (DIPO-60).

export {
  ABSENT,
  answerOf,
  maintainerPresent,
  PermissionAsks,
  QUESTION_CLOSED,
  REPLY_NOT_SENT,
  type PermissionAsksDeps,
  type Presence,
} from "./permissions";
export {
  closeQuestion,
  findQuestion,
  insertPermissionQuestion,
  openQuestions,
  openQuestionViews,
  permissionText,
  questionViewOf,
  storyQuestionViews,
  type NewPermissionQuestion,
  type QuestionClose,
  type StoredQuestion,
} from "./questions";
export type { HookCall, HookEvent, HookEventKind, HookReply, PermissionDecision } from "./types";
export {
  BUDGET_NUDGE_SHARE,
  budgetFact,
  composeNudge,
  contextPathsOf,
  gitInputChanges,
  inputPathsOf,
  NUDGE_MAX_CHARS,
  NUDGE_TEMPLATES,
  nudgeCount,
  nudgedInSession,
  Nudges,
  nudgeSignature,
  nudgeText,
  parseInputChanges,
  writeFacts,
  writeNudgeSources,
  type InputChange,
  type InputChangeReader,
  type NudgeFact,
  type NudgesDeps,
  type NudgeSources,
} from "./nudges";
