// Office init (DIPO-36; 0010 sections 2, 6 and 11): the `office.init` command, its lane operation
// kind, the settings it records for uninstall, and the statuses check runs depend on.

export { INIT_NOTICES, OfficeInit, officeStatusesReady, planInit, STATUSES_STEP } from "./init";
export type { BaseState, InitPlan, InitResult, OfficeInitDeps } from "./init";
export {
  configGet,
  DIPO_GITIGNORE,
  DIPO_GITIGNORE_TEXT,
  INIT_KIND,
  initKind,
  InitTarget,
  OFFICE_SETTINGS,
  STEP_SUBJECTS,
  tasksWithStatus,
} from "./ops";
export type { InitStep } from "./ops";
export { previousSettings, recordPrevious, settingValue } from "./previous";
export type { PreviousSetting, SettingValue } from "./previous";
export {
  CONFIG_FILE,
  DEFAULT_STATUS,
  formatStatuses,
  LEGACY_STATUS,
  LIFECYCLE_STATUSES,
  missingStatuses,
  readStatuses,
  rewriteStatusesLine,
  RUN_STATUSES,
  statusesRefusal,
  targetStatuses,
} from "./statuses";
export type { StatusesRead } from "./statuses";
