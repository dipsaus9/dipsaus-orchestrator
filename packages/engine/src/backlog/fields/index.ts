// A story's non-native fields (0010 section 3): the `dipo` field block, the reserved labels, and
// the single write path that changes them through the Backlog CLI.

export {
  BLOCK_CLOSE,
  BLOCK_OPEN,
  emitFieldBlock,
  FieldBlockError,
  locateBlock,
  parseBlockContent,
  parseFieldBlock,
  spliceFieldBlock,
} from "./block";
export type { BlockLocation, ParsedDescription } from "./block";
export {
  isValidLabel,
  LABEL_GRAMMAR,
  labelEditArgs,
  readLabels,
  ROLE_PREFIX,
  TEST_BEFORE_MERGE,
  TIER_PREFIX,
} from "./labels";
export type { LabelChange, StoryLabels } from "./labels";
export { editLabels, FieldWriteError, MAX_WRITE_ATTEMPTS, viewStory, writeFields } from "./write";
export type { StoryTarget } from "./write";
