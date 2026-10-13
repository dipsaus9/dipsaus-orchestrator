// The log reader of `client/node` behind `dipo daemon logs` (0006 decision 13, DIPO-64).

export {
  DAEMON_LOG_FILE,
  DAEMON_LOG_KEEP,
  FOLLOW_INTERVAL_MS,
  followLogs,
  LogFollower,
  matchesFilter,
  parseLogLine,
  readLogs,
  readRotatedLines,
  renderFiltered,
  renderLogLine,
  rotatedLogPaths,
} from "./reader";
export type { FollowLogsOptions, LogEntry, LogFilter, ReadLogsResult } from "./reader";
