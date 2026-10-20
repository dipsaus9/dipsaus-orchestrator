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
  answerParkQuestion,
  parkedElsewhere,
  staleParkQuestions,
  type ParkAnswerResult,
  type ParkResumer,
} from "./park-answers";
export {
  OFFICE_CONFIG_FILE,
  parkAnswerMessage,
  parkQuestionText,
  permissionDetail,
  recordedPermission,
  sandboxBinding,
  type RecordedPermission,
  type SandboxFacts,
} from "./park-questions";
export {
  closeQuestion,
  findQuestion,
  insertParkQuestion,
  insertPermissionQuestion,
  openParkQuestions,
  openQuestions,
  takeAllowOnce,
  type NewParkQuestion,
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
  copyNudgeSources,
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
  type NudgeSourceKind,
  type NudgesDeps,
  type NudgeSources,
} from "./nudges";
export { bashRefusal } from "./bash-check";
export { GH_REFUSAL, ghHelpCall, ghRefusal } from "./gh-guard";
export { GUARDED_TEMP_VARIABLES, refusedTempVariable, tempVariableRefusal } from "./temp-guard";
export {
  findSecret,
  MIN_SECRET_CHARS,
  parseEnvText,
  readEnvSecrets,
  refusalText,
  UNCHECKED_TEXT,
  WebGuard,
  webCallCounts,
  type EnvSecret,
  type SecretHit,
  type WebGuardDeps,
} from "./web-guard";
