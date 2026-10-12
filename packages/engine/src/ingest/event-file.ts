// Reading a run's `events.ndjson` from a stored byte offset (0007 section 5, 0006 decision 8).
// Only complete lines count: a partial last line waits for the next read. The file's identity
// (device, inode) and size tell whether it is still the append-only file the host started.

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Device and inode of a file, plus its size now. */
export interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
}

/** The file's identity, or null when it does not exist (yet). */
export function statEventFile(path: string): FileIdentity | null {
  try {
    const stat = statSync(path);
    return { device: stat.dev, inode: stat.ino, size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** One complete line and the byte offset just after its newline. */
export interface FileLine {
  readonly text: string;
  readonly end: number;
}

/** The most one read takes; a longer tail is read by the next pass. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

const decoder = new TextDecoder();

/**
 * The complete lines between `from` and `size`, at most about `maxBytes` of them. A line longer
 * than `maxBytes` is read whole, so the reader never stalls on it.
 */
export function readCompleteLines(
  path: string,
  from: number,
  size: number,
  maxBytes: number = MAX_READ_BYTES,
): FileLine[] {
  if (size <= from) return [];
  const fd = openSync(path, "r");
  try {
    let length = Math.min(size - from, maxBytes);
    for (;;) {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, from + read);
        if (n === 0) break;
        read += n;
      }
      const bytes = buffer.subarray(0, read);
      const last = bytes.lastIndexOf(0x0a);
      if (last < 0) {
        // No newline yet: either the line is still being written, or it is longer than the cap.
        if (from + read >= size) return [];
        length = size - from;
        continue;
      }
      const lines: FileLine[] = [];
      let start = 0;
      for (let at = bytes.indexOf(0x0a); at >= 0 && at <= last; at = bytes.indexOf(0x0a, start)) {
        lines.push({ text: decoder.decode(bytes.subarray(start, at)), end: from + at + 1 });
        start = at + 1;
      }
      return lines;
    }
  } finally {
    closeSync(fd);
  }
}

/** `length` bytes at `from`, or fewer when the file ends first. */
export function readRange(path: string, from: number, length: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, from + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}
