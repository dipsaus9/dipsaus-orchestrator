// The context provider (0014 section 9) and the default provider (DIPO-46).

export {
  COMPONENT_MAP_PATH,
  componentFiles,
  matchComponents,
  validateComponentMap,
} from "./components";
export type {
  Component,
  ComponentMapResult,
  ComponentMatch,
  ComponentVia,
  ScopeKind,
} from "./components";
export {
  createDefaultProvider,
  DEFAULT_PROVIDER_ID,
  DEFAULT_PROVIDER_VERSION,
  itemCostOf,
  normalisePath,
} from "./default-provider";
export type { DefaultProviderOptions } from "./default-provider";
export { gatherContext } from "./gather";
export type { GatherContextOptions } from "./gather";
export {
  contextPackOf,
  encodePack,
  forgetContextPack,
  gitBlobId,
  packDigest,
  recordContextPack,
} from "./pack";
export type { ContextPackRecord } from "./pack";
export {
  COMPONENT_FILES_MAX,
  CONTEXT_BUDGETS,
  CONTEXT_ITEM_MAX,
  DIRECTORY_ENTRIES_MAX,
  INPUT_FILE_MAX,
  INPUTS_BUDGETS,
  SIZE_CLASS_LIMITS,
  sizeClassOf,
  sizeClassOfWorkspace,
} from "./size";
export { isSecretPath } from "./secrets";
export {
  formatCount,
  listingTruncationMarker,
  truncateHead,
  truncateListing,
  truncationMarker,
} from "./truncate";
export type { Truncated } from "./truncate";
export type {
  ContextItem,
  ContextPack,
  ContextProvenance,
  ContextProvider,
  ContextReason,
  ContextRequest,
  FileContent,
  FileRefusal,
  InputsPart,
  ProviderState,
  ProviderStatus,
  SizeClass,
  Workspace,
} from "./types";
export { commitWorkspace, gitWorkspace } from "./workspace";
export type { GitWorkspaceOptions } from "./workspace";
