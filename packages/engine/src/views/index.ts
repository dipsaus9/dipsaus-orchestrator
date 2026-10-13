// Views derived by the engine (0005 section 6, open question 4): the minimal story view the change
// log carries and the office summary `engine.hello` and the software stream send (DIPO-32).
// DIPO-52 extends both.

export {
  activeStoryViews,
  columnOf,
  deriveStoryView,
  isUnknownStatus,
  LIFECYCLE_COLUMNS,
  lifecycleOf,
  storyView,
} from "./story";
export type { StoryFacts } from "./story";
export {
  activeRunCount,
  columnCounts,
  deriveOfficeSummary,
  officeSummaries,
  officeSummarySource,
} from "./summary";
export type { OfficeIdentity } from "./summary";
