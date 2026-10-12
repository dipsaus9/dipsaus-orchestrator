// The log file sink: appends lines to `<logs>/daemon.log` (0006 decision 13). The directory is
// created with mode 0700 and the file with mode 0600. Rotation follows in DIPO-64.

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

import type { LogSink } from "./logger";

export const DAEMON_LOG_FILE = "daemon.log";

export interface LogFile {
  readonly path: string;
  readonly sink: LogSink;
  close(): void;
}

export function openLogFile(logsDir: string, name: string = DAEMON_LOG_FILE): LogFile {
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const path = join(logsDir, name);
  let fd: number | null = openSync(path, "a", 0o600);
  return {
    path,
    sink: (line) => {
      if (fd !== null) writeSync(fd, `${line}\n`);
    },
    close: () => {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}
