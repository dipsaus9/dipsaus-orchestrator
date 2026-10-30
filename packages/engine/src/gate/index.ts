// The Ready gate (0012 section 3, R26 from 0014 section 4): a pure function of the story, the
// office's active tasks and office configuration. `gate-decisions/` keeps decisions and serves the read
// `story.gate` (DIPO-71).

export { evaluateGate, rulesFor } from "./evaluate";
export { gateContent, gateContentHash } from "./hash";
export { gateStoryFromView, gateTaskFromView } from "./input";
export {
  contractCharacters,
  cycleThrough,
  gateMessage,
  gateWarningMessage,
  gateText,
  isValidScopePath,
  outcomeLines,
  pathsCollide,
  r01a,
  r01b,
  r02,
  r03,
  r04,
  r05,
  r06,
  r07,
  r08,
  r09,
  r10,
  r11,
  r12,
  r13,
  r14,
  r15,
  r16,
  r17,
  r18,
  r19,
  r20,
  r21,
  r22,
  r23,
  r24,
  r25,
  r26,
  r29,
  r30,
  SHARED_RULES,
  WARNING_RULES,
  TEST_PLAN_TEXT_MIN,
} from "./rules";
export type { GateContext, RuleCheck } from "./rules";
export { characters, clean, wordMatch } from "./text";
export { BUILT_IN_ROSTER, GATE_RULES } from "./types";
export type {
  GateConfig,
  GateCriterion,
  GateDependency,
  GateFailure,
  GateInput,
  GateMode,
  GateResult,
  GateRole,
  GateRule,
  GateStory,
  GateTask,
} from "./types";
