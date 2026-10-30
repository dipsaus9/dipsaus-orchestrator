// The daemon's files under `<state>` that the client reads without the socket (0006 decisions 2
// and 6): the lock `dipo.pid` and `runtime.json`. The record format is DIPO-23's; `client` may not
// import `engine` (0004), so the parser is repeated here and `test/lifecycle-parity` runs both.
//
// The client never deletes `dipo.pid`: the starting daemon is the lock's one deleter (0005). A stale
// `runtime.json` it removes only when it still holds what was judged stale: it renames the file
// aside, checks the renamed content, and deletes it; otherwise it puts the newer file back with
// `link()`, which never clobbers.

import { linkSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { RUNTIME_FILE } from "../runtime";

export const PID_FILE = "dipo.pid";

/** The content of `dipo.pid` (DIPO-23). */
export interface PidRecord {
  readonly pid: number;
  /** Start time as the process probe reads it, ms since the epoch. */
  readonly startTimeMs: number;
  readonly version: string;
  /** The runtime directory in use; null until the holder has chosen it. */
  readonly runtimeDir: string | null;
}

export function parsePidRecord(raw: string): PidRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<PidRecord>;
    if (
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.startTimeMs === "number" &&
      typeof value.version === "string" &&
      (value.runtimeDir === null || typeof value.runtimeDir === "string")
    ) {
      return {
        pid: value.pid,
        startTimeMs: value.startTimeMs,
        version: value.version,
        runtimeDir: value.runtimeDir,
      };
    }
  } catch {
    // Not JSON: a record being written, or damage.
  }
  return null;
}

/** A file as read: its raw text, to compare before removing it. */
export interface ReadFile {
  readonly path: string;
  readonly raw: string;
}

/** Reads `path`; null when it does not exist. */
export function readRaw(path: string): ReadFile | null {
  try {
    return { path, raw: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}

export function pidFilePath(state: string): string {
  return join(state, PID_FILE);
}

export function runtimeFilePath(state: string): string {
  return join(state, RUNTIME_FILE);
}

/** The PID and start time `runtime.json` names, when it parses. */
export function runtimeIdentity(raw: string): { pid: number; startTimeMs: number } | null {
  try {
    const value = JSON.parse(raw) as { pid?: unknown; startTimeMs?: unknown };
    if (typeof value.pid === "number" && typeof value.startTimeMs === "number") {
      return { pid: value.pid, startTimeMs: value.startTimeMs };
    }
  } catch {
    // Damaged: no identity.
  }
  return null;
}

const defaultRandom = () => crypto.randomUUID().slice(0, 8);

/**
 * Removes `file` only if it still holds the content that was read: rename aside, compare, delete,
 * or restore a newer file with `link()`. True when the stale file was removed.
 */
export function removeIfUnchanged(
  file: ReadFile,
  ownPid: number = process.pid,
  random: () => string = defaultRandom,
): boolean {
  const aside = `${file.path}.stale.${ownPid}.${random()}`;
  try {
    renameSync(file.path, aside);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
  if (readFileSync(aside, "utf8") === file.raw) {
    unlinkSync(aside);
    return true;
  }
  try {
    linkSync(aside, file.path);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
  }
  unlinkSync(aside);
  return false;
}
