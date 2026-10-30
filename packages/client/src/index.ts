// The main entry of `@dipsaus-orchestrator/client`: the runtime-free protocol core every UI shares
// (0004 amendment of 2026-10-12). A lint rule keeps Bun and Node APIs out of it; the Unix-socket
// transport is in `@dipsaus-orchestrator/client/node`.

export const packageName = "@dipsaus-orchestrator/client";

export {
  ClientError,
  CONNECT_TIMEOUT_MS,
  DipoClient,
  LIVENESS_MS,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  reconnectDelay,
  STREAM_MARK_MS,
} from "./client";
export type {
  ClientOptions,
  CommandOptions,
  CommandOutcome,
  ConnectionState,
  HelloResult,
  ReadOutcome,
  RequestOptions,
  SubscribeOptions,
  Subscription,
} from "./client";
export { RECOVERY_NOTICE_MS, RECOVERY_POLL_MS, STATUS_FAILURES, waitForRecovery } from "./recovery";
export type { RecoveringSession, RecoveryOptions, RecoverySession } from "./recovery";
export { ulidRequestIds } from "./request-id";
export {
  cursorReached,
  OfficeStore,
  RELOADED_NOTICE,
  STREAM_RETRY_MAX_MS,
  streamRetryDelay,
} from "./store/index";
export type {
  OfficeEntry,
  OfficeStoreOptions,
  OfficeStoreState,
  OutputChunk,
  StoreClient,
} from "./store/index";
export type { RandomBytes, RequestIds } from "./request-id";
export type { Transport, TransportConnection, TransportHandlers } from "./transport";
export { healthLabel, healthMeaning } from "./health-text";
export { markerRule } from "./marker-text";
export { byteLength, outputPieces, textFrom } from "./output-range";
export type { OutputRange } from "./output-range";
export { storyRef } from "./story-ref";
export { percent, resetText, usageParts, usageTokens, usageWindowText } from "./usage-text";
