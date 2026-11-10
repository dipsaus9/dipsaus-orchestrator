// The repository scan (0013): pure detection (DIPO-33), the stored run profile with its rescans
// (DIPO-72), and the fallback with the maintainer's confirmations (DIPO-310).

export * from "./detect";
export { checkAnswer, SCAN_ANSWER_JSON_SCHEMA, ScanAnswerSchema } from "./answer";
export type { AnswerCheck, BaseFacts, CheckedProposal, DroppedProposal } from "./answer";
export {
  CONFIRM_COMMAND,
  effectiveProfile,
  INFER_COMMAND,
  NO_MARKS,
  PROFILE_COMMAND,
} from "./confirm";
export type { CapabilityMark, Confirmation, Proposal, ScanMarks } from "./confirm";
export { diffProfiles, profileFacts, profileScripts, shownCommand, shownSpec } from "./diff";
export { buildEvidence, requestItems } from "./evidence";
export type { EvidenceBundle, EvidenceItem, RequestItem } from "./evidence";
export { RunProfiles, SCAN_DEFAULTS, SCAN_STEP } from "./feature";
export type { RunProfilesDeps, ScanOutcome } from "./feature";
export { SCAN_MAX_TURNS, SCAN_NOTICES, SCAN_ROLE, ScanFallback } from "./fallback";
export type {
  ScanSessionRequest,
  ScanSessionResult,
  ScanSessionRunner,
  ScanSessionSettings,
} from "./fallback";
export { profileDeskItems, profileView } from "./profile-view";
export type { ProfileDeskItem } from "./profile-view";
export {
  currentFingerprint,
  currentProfile,
  insertProfile,
  insertScan,
  storedProfile,
  testCommandRefusal,
  verifyResolved,
} from "./store";
export type { ScanRecord, ScanTrigger, StoredProfile } from "./store";
