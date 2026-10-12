export { officeFeature } from "./feature";
export { OfficeManager } from "./manager";
export type { ForgetResult, OfficeManagerDeps, OpenResult, ReloadConfigResult } from "./manager";
export {
  MARKER_FILE,
  markerPath,
  OFFICE_DIR,
  officeDirectory,
  OfficeMarker,
  readMarker,
  writeMarker,
} from "./marker";
export type { MarkerRead } from "./marker";
export {
  BACKLOG_CONFIG,
  canonicalPath,
  isBacklogProject,
  mainWorktreeOf,
  networkFsType,
  resolveRepository,
} from "./repository";
export type { GitRunner, Repository, ResolveResult } from "./repository";
export type {
  ActiveWorkCheck,
  LoadStep,
  LoadStepResult,
  OfficeLoadContext,
  RegisteredActiveWorkCheck,
  RegisteredLoadStep,
} from "./steps";
