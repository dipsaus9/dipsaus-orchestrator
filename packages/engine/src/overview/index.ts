// The maintainer's office reads (0004, 0005, 0009, 0020): the office summary for `engine.hello`
// and the software stream send, the desk, the digest, the proposals on the desk, and the view
// reads (`office.snapshot`, `office.switch`, `story.detail`, `work.outputRange`).

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
  desk,
  DESK_DETAIL_MAX,
  DESK_SOURCES,
  deskLine,
  deskText,
  implementedIn,
  registerDesk,
} from "./desk";
export type { DeskGate, DeskSources, HandDeskItem, Implemented } from "./desk";
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
} from "./feature";
