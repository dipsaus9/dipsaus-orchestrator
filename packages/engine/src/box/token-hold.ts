// The box-token hold outside memory (DIPO-271, DIPO-269's post-run token check). A hold for a
// token found in a box, or for a check that could not finish, stays until the maintainer replaces
// the box login with `dipo login box`; a passing launch check does not lift it, and neither does a
// daemon restart. The record is one file in dipo's state directory:
//
// - the daemon writes it when it holds (`AdapterHolds` with this store as its sticky store) and
//   reads it again on every look, so it restores the hold after a restart;
// - `dipo login box` removes it once the new token is stored, which lifts the hold at the
//   daemon's next look, without a daemon call.
//
// The file holds fixed texts and error codes only (`tokenCheckFailure`), never the token. A file
// that cannot be read or parsed counts as a hold: a check that cannot be read proves nothing.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  LaunchCheckFailure,
  StickyHoldRecord,
  StickyHoldStore,
  StickyHolds,
} from "../workers/hold";
import { BOX_TOKEN_CHECK } from "./token-check";

/** The record's file name in dipo's state directory. */
export const BOX_TOKEN_HOLD_FILE = "box-token-hold.json";

/** How the hold is lifted, as the refusal and the notice say it. */
export const BOX_TOKEN_LIFTED_BY =
  "This hold stays until the box login is replaced with `dipo login box`; a passing launch check does not lift it.";

/** The record's path in `stateDir`. */
export function boxTokenHoldPath(stateDir: string): string {
  return join(stateDir, BOX_TOKEN_HOLD_FILE);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function failureOf(value: unknown): LaunchCheckFailure | null {
  if (typeof value !== "object" || value === null) return null;
  const { check, detail, fix } = value as Record<string, unknown>;
  if (typeof check !== "string" || typeof detail !== "string") return null;
  return { check, detail, ...(typeof fix === "string" ? { fix } : {}) };
}

/** A record that could not be read: it holds, as a check that read nothing proves nothing. */
function unreadable(adapter: string, why: string): StickyHoldRecord {
  return {
    adapter,
    failures: [
      {
        check: BOX_TOKEN_CHECK,
        detail: `the box-token hold record could not be read (${why})`,
        fix: "Store a new box login with `dipo login box`, which also removes the record.",
      },
    ],
    since: 0,
  };
}

/**
 * Reads the record at `path`: null when there is none. A record that cannot be read holds
 * `adapter`, the adapter the box ran.
 */
export function readBoxTokenHold(path: string, adapter: string): StickyHoldRecord | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    return unreadable(adapter, errorCode(error) ?? "read failed");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return unreadable(adapter, "not JSON");
  }
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const failures = Array.isArray(record["failures"])
    ? record["failures"].map(failureOf).filter((failure) => failure !== null)
    : [];
  if (typeof record["adapter"] !== "string" || failures.length === 0) {
    return unreadable(adapter, "no adapter or no failure");
  }
  return {
    adapter: record["adapter"],
    failures,
    since: typeof record["since"] === "number" ? record["since"] : 0,
  };
}

/** Writes the record at `path`, owner only, by a rename. */
export function writeBoxTokenHold(path: string, record: StickyHoldRecord): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Removes the record at `path`; true when there was one. */
export function clearBoxTokenHold(path: string): boolean {
  let had = true;
  try {
    readFileSync(path);
  } catch {
    had = false;
  }
  rmSync(path, { force: true });
  return had;
}

/** The box-token check as the daemon's sticky holds for `adapter`, kept in the record at `path`. */
export function boxTokenStickyHolds(path: string, adapter: string): StickyHolds {
  const store: StickyHoldStore = {
    read: () => readBoxTokenHold(path, adapter),
    write: (record) => writeBoxTokenHold(path, record),
    clear: () => {
      clearBoxTokenHold(path);
    },
  };
  return { checks: new Set([BOX_TOKEN_CHECK]), liftedBy: BOX_TOKEN_LIFTED_BY, store };
}
