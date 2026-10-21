// One real box per story (0021 sections 1 to 6, DIPO-265): the box interface and its Apple
// `container` backend.

export {
  BOX_KEEPALIVE,
  BOX_NETWORK_LABEL_VALUE,
  BOX_NETWORK_NAME,
  checkedBoxName,
  copyInArgs,
  copyOutArgs,
  createArgs,
  deleteArgs,
  execArgs,
  listArgs,
  networkCreateArgs,
  networkListArgs,
  startArgs,
  statsArgs,
  stopArgs,
  systemStatusArgs,
  versionArgs,
} from "./apple-args";
export type { CreateInput, ExecInput, HostResources } from "./apple-args";
export {
  APPLE_CONTAINER_BACKEND_ID,
  AppleContainerBoxes,
  boxMemory,
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
  BOX_CALL_TIMEOUT_MS,
  BOX_LABEL,
  BOX_NAME_PREFIX,
  BOX_PACKAGE_CACHE_PATH,
  BoxError,
  boxName,
  isBoxTimedOut,
  runIdOfBox,
} from "./port";
export type {
  BoxCallOptions,
  BoxCheck,
  BoxExecOptions,
  BoxExecResult,
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
  checkBoxForToken,
  TOKEN_CHECK_ARCHIVE,
  TOKEN_CHECK_ARCHIVE_COMMAND,
  TOKEN_CHECK_ARCHIVE_TIMEOUT_MS,
  TOKEN_CHECK_ENV_COMMAND,
} from "./token-check";
export type { BoxTokenCheck, TokenCheckDeps, TokenFoundIn } from "./token-check";
