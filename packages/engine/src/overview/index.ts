// The maintainer's office reads (0004, 0005, 0009, 0020): the office summary for `engine.hello`
// and the software stream send, the desk, the digest, the proposals on the desk, and the view
// reads (`office.snapshot`, `story.detail`, `work.outputRange`).

export {
  columnCounts,
  deriveOfficeSummary,
  officeSummaries,
  officeSummaryOf,
  officeSummaryOfSource,
  officeSummarySource,
  openGateViews,
  runningStoryCount,
  sessionRunCount,
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
export { digest, DIGEST_COUNTS, DIGEST_LINES_MAX, registerDigest } from "./digest";
export type { DigestCount } from "./digest";
<<<<<<< ea4b37b498a7f22c701c89e050eac2feef0d4387
export { ideaCard, ideaItems, openDecisionNotes } from "./proposals";
export type { IdeaItem, NoteItem } from "./proposals";
=======
>>>>>>> de146a854c2be9713e40505688960f87444be951
export {
  detail,
  OUTPUT_RANGE_MAX_BYTES,
  outputRange,
  snapshot,
  storyRuns,
  storedPrompt,
  storyVerdicts,
} from "./feature";
