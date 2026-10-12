// `host.log`: the host's own JSON log lines (0006 decision 13), capped at 5 MB by dropping the
// oldest half. The host process's stdout and stderr are appended to the same file by the engine
// that started it, so the file is shortened in place (truncate, then write the kept half): an
// append-mode descriptor on the same file keeps writing at its end.

import { closeSync, fstatSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";

import type { LogSink } from "../log/logger";

export interface HostLog {
  readonly path: string;
  readonly sink: LogSink;
  close(): void;
}

/**
 * The newer half of `content`, starting after the first newline at or past its middle, so no
 * partial line is kept. Empty when the newer half holds no line break.
 */
export function newerHalf(content: Buffer): Buffer {
  const middle = Math.floor(content.byteLength / 2);
  const newline = content.indexOf(0x0a, middle === 0 ? 0 : middle - 1);
  return newline < 0 ? Buffer.alloc(0) : content.subarray(newline + 1);
}

function writeAll(handle: number, bytes: Buffer): void {
  let written = 0;
  while (written < bytes.byteLength) {
    written += writeSync(handle, bytes, written, bytes.byteLength - written);
  }
}

export function openHostLog(path: string, capBytes: number): HostLog {
  let fd: number | null = openSync(path, "a", 0o600);
  return {
    path,
    sink: (line) => {
      if (fd === null) return;
      const bytes = Buffer.from(`${line}\n`);
      // Re-read the size: the process's own stdout and stderr append to this file too.
      if (fstatSync(fd).size + bytes.byteLength > capBytes) {
        const kept = newerHalf(readFileSync(path));
        ftruncateSync(fd, 0);
        writeAll(fd, kept);
      }
      writeAll(fd, bytes);
    },
    close: () => {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}
