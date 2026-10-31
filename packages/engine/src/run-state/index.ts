// The run-state writes that the run, claims, merges and reconcile share (0004): phases and review
// rounds, the worker and reviewer places with the pre-start caps, parks, questions and merge gates.

// The office's worker and reviewer places and the run across review rounds (DIPO-142).
export {
  claimPlace,
  PLACE_NOTICES,
  PLACE_TICK_MS,
  placeHolders,
  placeOfRole,
  placeOfRun,
  placeOfStart,
  Places,
  PLACES,
  PLACES_STEP,
  placeTaken,
  START_KINDS,
  startOrder,
  waitForPlace,
  waitingStarts,
} from "./places";
export type { Place, PlacesDeps, PlaceStart, PlaceStarter, StartKind } from "./places";
export {
  endReviewPeriod,
  enterPhase,
  phaseAfterVerdict,
  reopen,
  reviewedInReview,
  stopAtInReview,
  waitsForReview,
} from "./rounds";
export type { ReopenFor, RoundKind } from "./rounds";
export { preStartEnding, reachedCaps } from "./pre-start-caps";
// The merge gates in front of a story PR's auto-merge (0002).
export {
  AUTORELEASE_LABEL,
  autoreleasePending,
  decideMergeGate,
  decideOnHandMerge,
  decideTestedMergeGates,
  HAND_MERGE_NOTE,
  holdLabelsOn,
  MERGE_GATE_KIND,
  mergeGate,
  mergeGatesOfRun,
  mergeGateSummary,
  mergeWaits,
  openMaintainerMergeGate,
  openMergeGate,
  overrideGateOf,
  overrideGateSummary,
  RELEASE_PATH_HOLD,
  releasePathList,
} from "./gates";
export type { HandMerge, MergeWait, StoredMergeGate } from "./gates";
// The questions a worker asks and the maintainer answers (0008, 0020).
export {
  closeQuestion,
  findQuestion,
  openParkQuestions,
  openQuestions,
  openQuestionViews,
  permissionText,
  questionViewOf,
  storyQuestionViews,
  type QuestionClose,
  type StoredQuestion,
} from "./questions";
