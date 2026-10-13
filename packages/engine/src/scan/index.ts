// The repository scan (0013): pure detection (DIPO-33) and the stored run profile with its
// rescans (DIPO-72).

export * from "./detect";
export { diffProfiles, profileFacts, profileScripts, shownCommand, shownSpec } from "./diff";
export { RunProfiles, SCAN_STEP } from "./feature";
export type { RunProfilesDeps, ScanOutcome } from "./feature";
export {
  currentFingerprint,
  currentProfile,
  insertProfile,
  insertScan,
  storedProfile,
  verifyResolved,
} from "./store";
export type { ScanRecord, ScanTrigger, StoredProfile } from "./store";
