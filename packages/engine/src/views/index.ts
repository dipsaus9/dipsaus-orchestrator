// Views derived by the engine (0005 section 6, open question 4): story views, work views with
// health, the office summary `engine.hello` and the software stream send, and the view reads
// (`office.snapshot`, `office.switch`, `story.detail`, `work.outputRange`).

export {
  activeStoryViews,
  columnOf,
  deriveColumn,
  deriveStoryView,
  gateFailures,
  isUnknownStatus,
  LIFECYCLE_COLUMNS,
  lifecycleOf,
  storyView,
  workByKey,
} from "./story";
export type { GateFailureFact, ParkFacts, StoryFacts } from "./story";
export {
  activeRunCount,
  columnCounts,
  deriveOfficeSummary,
  officeSummaries,
  officeSummaryOf,
  officeSummaryOfSource,
  officeSummarySource,
  openGateViews,
  summarySettings,
} from "./summary";
export type { OfficeIdentity, SummarySettings, SummarySettingsOf } from "./summary";
export {
  activeWorkViews,
  deriveHealth,
  WORK_VIEW_TYPES,
  withWorkViews,
  workRefOf,
  workView,
} from "./work";
export type { HealthFacts } from "./work";
export {
  desk,
  DESK_DETAIL_MAX,
  DESK_SOURCES,
  deskLine,
  deskText,
  implementedIn,
  policyResumeNeeds,
  registerDesk,
} from "./desk";
export type {
  DeskGate,
  DeskSources,
  HandDeskItem,
  Implemented,
  ResumeNeed,
  ResumeNeeds,
} from "./desk";
export {
  digest,
  DIGEST_COUNTS,
  DIGEST_LINES_MAX,
  recordTuiLeft,
  registerDigest,
  tuiLeftAt,
} from "./digest";
export type { DigestCount } from "./digest";
export { openDecisionNotes, openProposals, proposalItems } from "./proposals";
export type { ProposalItem } from "./proposals";
export {
  detail,
  OUTPUT_RANGE_MAX_BYTES,
  outputRange,
  snapshot,
  storyRuns,
  storedPrompt,
  storyVerdicts,
  viewsFeature,
} from "./feature";
export {
  DEFAULT_USAGE_LIMITS,
  sumUsage,
  summaryUsage,
  USAGE_SNAPSHOT_MS,
  UsageMeter,
  windowResetsAt,
  windowUsage,
} from "./usage";
export type { SummaryUsage, UsageLimits, UsageSnapshot, WindowSum, WindowSums } from "./usage";
