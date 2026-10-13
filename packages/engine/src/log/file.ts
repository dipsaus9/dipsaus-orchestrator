// The log file sink: appends lines to `<logs>/daemon.log` (0006 decision 13). The directory is
// created with mode 0700 and the file with mode 0600. The daemon rotates the file itself, because
// launchd does not rotate and journald sees only stderr: a line that would take `daemon.log` past
// 10 MB first moves it to `daemon.log.1`, shifts older files up to `daemon.log.5` and drops the
// oldest, then starts a new `daemon.log`. `dipo daemon logs` (client/node) reads the same names.

import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import type { LogSink } from "./logger";

export const DAEMON_LOG_FILE = "daemon.log";
/** Rotation size of `daemon.log` (0006 decision 13). */
export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Rotated files kept next to `daemon.log`: `daemon.log.1` (newest) to `daemon.log.5`. */
export const DAEMON_LOG_KEEP = 5;

export interface LogFile {
  readonly path: string;
  readonly sink: LogSink;
  close(): void;
}

export interface OpenLogFileOptions {
  readonly name?: string;
  /** Rotate before a line would take the file past this size; tests pass a small value. */
  readonly maxBytes?: number;
  /** How many rotated files to keep. */
  readonly keep?: number;
}

/** Moves `<path>` to `<path>.1` after shifting `.1` to `.keep-1` up one; the oldest is dropped. */
export function rotateFiles(path: string, keep: number): void {
  rmSync(`${path}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${path}.${index}`, `${path}.${index + 1}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  renameSync(path, `${path}.1`);
}

function writeAll(fd: number, bytes: Buffer): void {
  let written = 0;
  while (written < bytes.byteLength) {
    written += writeSync(fd, bytes, written, bytes.byteLength - written);
  }
}

export function openLogFile(logsDir: string, options: OpenLogFileOptions = {}): LogFile {
  const maxBytes = options.maxBytes ?? DAEMON_LOG_MAX_BYTES;
  const keep = options.keep ?? DAEMON_LOG_KEEP;
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const path = join(logsDir, options.name ?? DAEMON_LOG_FILE);
  let fd: number | null = openSync(path, "a", 0o600);
  let size = fstatSync(fd).size;
  return {
    path,
    sink: (line) => {
      if (fd === null) return;
      const bytes = Buffer.from(`${line}\n`);
      if (size > 0 && size + bytes.byteLength > maxBytes) {
        closeSync(fd);
        fd = null;
        try {
          rotateFiles(path, keep);
        } finally {
          // Even when a rename fails, keep logging: to the new file, or on to the old one.
          fd = openSync(path, "a", 0o600);
          size = fstatSync(fd).size;
        }
      }
      writeAll(fd, bytes);
      size += bytes.byteLength;
    },
    close: () => {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}
