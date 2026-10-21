// One real box per story (0021 sections 1 to 6, DIPO-265): the box interface and its Apple
// `container` backend, and the box image built from the office config (DIPO-266).

export {
  BOX_IMAGE_LABEL_VALUE,
  BOX_KEEPALIVE,
  BOX_NETWORK_LABEL_VALUE,
  BOX_NETWORK_NAME,
  BUILD_NETWORK_NAME,
  BUILD_PROXY_ARG,
  buildArgs,
  builderStartArgs,
  checkedBoxName,
  copyInArgs,
  copyOutArgs,
  createArgs,
  deleteArgs,
  execArgs,
  exportArgs,
  imageInspectArgs,
  listArgs,
  networkCreateArgs,
  networkListArgs,
  startArgs,
  statsArgs,
  stopArgs,
  systemStatusArgs,
  versionArgs,
} from "./apple-args";
export type { BuildInput, CreateInput, ExecInput, HostResources } from "./apple-args";
export {
  APPLE_CONTAINER_BACKEND_ID,
  AppleContainerBoxes,
  boxMemory,
  BUILD_ERROR_LINES,
  compareVersions as compareContainerVersions,
  dipoBoxes,
  findNetwork,
  MIN_CONTAINER_VERSION,
  parseContainerVersion,
  saysNotRunning,
  systemHostResources,
} from "./apple-container";
export type { AppleContainerDeps, BoxNetworkFound } from "./apple-container";
export {
  BOX_BUILD_CA_FILE,
  BOX_BUILD_FILE,
  BOX_BUILD_TIMEOUT_MS,
  BOX_CALL_TIMEOUT_MS,
  BOX_IMAGE_REPOSITORY,
  BOX_LABEL,
  BOX_NAME_PREFIX,
  BOX_PACKAGE_CACHE_PATH,
  BoxError,
  boxName,
  isBoxTimedOut,
  runIdOfBox,
} from "./port";
export type {
  BoxBuildNetwork,
  BoxCallOptions,
  BoxCheck,
  BoxClientCommand,
  BoxExecOptions,
  BoxExecResult,
  BoxImageBuild,
  BoxInfo,
  BoxMemory,
  BoxNetwork,
  BoxNetworkMode,
  BoxPort,
  BoxProcess,
  BoxSpec,
  BoxState,
} from "./port";
export {
  BOX_DEFAULTS,
  boxBuildFile,
  boxImageTag,
  checkImageDescription,
  describeBox,
  ensureBoxImage,
  NODE_TARBALL_SHA256,
  readBaseBox,
  readBaseBoxSection,
} from "./image";
export type {
  BaseBox,
  BaseBoxSection,
  BoxBuildProxy,
  BoxDescription,
  BoxFileEntry,
  BoxImageDescription,
  BoxImageRequest,
  BoxImageResult,
  BoxToolchain,
  NodeArch,
  NodeSha256,
} from "./image";
export {
  BOX_PLACEHOLDER_API_KEY,
  boxModelEnvironment,
  checkListenAddress,
  createModelProxyHandler,
  DROPPED_REQUEST_HEADERS,
  isModelRequest,
  MODEL_METHOD,
  MODEL_PATHS,
  MODEL_PROXY_MAX_BODY_BYTES,
  MODEL_UPSTREAM,
  OAUTH_BETA,
  proxyUrl,
  startModelProxy,
  upstreamHeaders,
  withOauthBeta,
} from "./model-proxy";
export type {
  BoxModelEnvironment,
  ListenHttp,
  ListeningHttp,
  ModelProxyDeps,
  ModelProxyHandlerOptions,
  RunningModelProxy,
  UpstreamFetch,
} from "./model-proxy";
export {
  findTokenArgs,
  isTokenShaped,
  readBoxToken,
  SECURITY_CLI,
  SECURITY_ITEM_NOT_FOUND,
  SecretToken,
  storeBoxToken,
  storeTokenArgs,
  TOKEN_KEYCHAIN_ACCOUNT,
  TOKEN_KEYCHAIN_LABEL,
  TOKEN_KEYCHAIN_SERVICE,
  TOKEN_READ_TIMEOUT_MS,
  TOKEN_REDACTED,
} from "./token";
export type {
  SpawnInteractive,
  TokenMatcher,
  TokenReadDeps,
  TokenScanner,
  TokenStoreDeps,
  TokenStoreResult,
} from "./token";
export {
  BOX_TOKEN_CHECK,
  checkBoxAfterRun,
  checkBoxForToken,
  sweepTokenCheckLeftovers,
  TAR_HEADER_BYTES,
  TOKEN_CHECK_DIR_PREFIX,
  TOKEN_CHECK_ENV_COMMAND,
  TOKEN_CHECK_EXPORT_FILE,
  TOKEN_CHECK_EXPORT_TIMEOUT_MS,
  tokenCheckFailure,
} from "./token-check";
export type { BoxTokenCheck, TokenCheckDeps, TokenFoundIn, TokenHoldDeps } from "./token-check";
export { ensureImageWithBuildProxy } from "./build-proxy";
export type { BuildProxyDeps } from "./build-proxy";
export {
  BOX_DIPO_DIR,
  BOX_WORKDIR,
  CODE_STAGE_PREFIX,
  stageBoxCode,
  SYSTEM_TAR,
  UNPACK_TIMEOUT_MS,
} from "./code";
export type { BoxCodeDeps, BoxCodeRequest, SkippedBoxFile, StagedBoxCode } from "./code";
export {
  BOX_TOKEN_HOLD_FILE,
  BOX_TOKEN_LIFTED_BY,
  boxTokenHoldPath,
  boxTokenStickyHolds,
  clearBoxTokenHold,
  readBoxTokenHold,
  writeBoxTokenHold,
} from "./token-hold";
export {
  BOX_CA_FILE,
  BOX_FILES_STAGE_PREFIX,
  BOX_INDEX_DIR,
  BOX_RUN_FILE,
  BOX_SYSTEM_FILE,
  BoxWorkers,
  readBoxRun,
} from "./workers";
export type { BoxFinish, BoxRunRecord, BoxSession, BoxWorkersDeps } from "./workers";
export {
  BoxWebRoute,
  checkAddress,
  startBoxWebProxy,
  startBoxWebRoute,
  systemInterfaceAddresses,
  WEB_PROXY_LIMITS,
} from "./web-proxy";
export type {
  BoxWebProxyDeps,
  BoxWebRouteStart,
  RunningBoxWebProxy,
  RunningBoxWebRoute,
  WebProxyEvent,
} from "./web-proxy";
