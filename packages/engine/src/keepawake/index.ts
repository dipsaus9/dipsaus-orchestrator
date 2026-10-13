// Keep-awake while work is active (0006 decision 12, DIPO-63).

export { CLAIM_START_WINDOW_MS, readWorkActivity, WorkTracker } from "./activity";
export { KEEP_AWAKE_SETTLE_MS, KeepAwakeHolder } from "./holder";
export type { KeepAwakeHolderDeps, KeepAwakeStatus } from "./holder";
export {
  DARWIN_LID_NOTE,
  describeWork,
  KEEP_AWAKE_POLL_MS,
  KEEP_AWAKE_RELEASE_MS,
  KeepAwake,
  NO_WORK,
  workCount,
} from "./keepawake";
export type { KeepAwakeDeps, WorkActivity } from "./keepawake";
