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
