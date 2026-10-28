// The hook relay's engine side (0008 section 5, DIPO-59): neutral hook events and replies, the
// `questions` table and the permission wait with `work.answer`; the 0014 section 8 nudges (DIPO-60).

export {
  ABSENT,
  PermissionAsks,
  QUESTION_CLOSED,
  REPLY_NOT_SENT,
  type PermissionAsksDeps,
  type Presence,
} from "./permissions";
export {
  closeQuestion,
  findQuestion,
  openParkQuestions,
  openQuestions,
  openQuestionViews,
  permissionText,
  questionViewOf,
  storyQuestionViews,
  type QuestionClose,
  type StoredQuestion,
} from "./questions";
export type { HookCall, HookEvent, HookEventKind, HookReply, PermissionDecision } from "./types";
export {
  BUDGET_NUDGE_SHARE,
  budgetFact,
  composeNudge,
  NUDGE_MAX_CHARS,
  NUDGE_TEMPLATES,
  nudgeCount,
  nudgedInSession,
  Nudges,
  nudgeSignature,
  nudgeText,
  type NudgeFact,
  type NudgesDeps,
} from "./nudges";
export {
  FETCH_RESOLVE_TIMEOUT_MS,
  type FetchAddressDeps,
  fetchAddressRefusal,
  fetchRefusalText,
  findSecret,
  MIN_SECRET_CHARS,
  parseEnvText,
  readEnvSecrets,
  refusalText,
  SYSTEM_FETCH_ADDRESSES,
  UNCHECKED_TEXT,
  WebGuard,
  webCallCounts,
  type EnvSecret,
  type SecretHit,
  type WebGuardDeps,
} from "./web-guard";
