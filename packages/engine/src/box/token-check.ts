// The post-run token check (0021 section 16, line 9, DIPO-269): after a run, dipo looks for the
// maintainer's subscription token in the box's environment and files, and holds the adapter when
// it finds it or cannot tell. The token never goes into the box for this:
//
// - the files are exported by the box backend from the host (`container export`), so no program
//   in the box shapes what is scanned; the archive is stream-scanned on the host and removed;
// - the environment is the box's `env` and every running process's /proc environ, read through
//   `exec`; an empty read proves nothing and fails the check.
//
// Comparison is in memory through a `TokenMatcher` (the model proxy). Results and hold details
// are fixed texts plus error codes: no token, no token fragment, no text from the box.

import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AdapterHold, AdapterHolds, LaunchCheckFailure } from "../workers/hold";
import { BoxError, type BoxPort } from "./port";
import type { TokenMatcher } from "./token";

/** The prefix of the host folder an export is scanned in; `sweepTokenCheckLeftovers` finds it. */
export const TOKEN_CHECK_DIR_PREFIX = "dipo-token-check-";
/** The export's file name in that folder. */
export const TOKEN_CHECK_EXPORT_FILE = "box.tar";
/** A tar archive is at least one 512-byte header; anything smaller is no export. */
export const TAR_HEADER_BYTES = 512;
/** How long the export may take; a box holds a whole toolchain. */
export const TOKEN_CHECK_EXPORT_TIMEOUT_MS = 10 * 60_000;
/** The launch check name of the hold this check raises. */
export const BOX_TOKEN_CHECK = "box-token";

/**
 * Prints the box's own environment and that of every process of the box user still running in it
 * (NUL-separated in /proc); the box's shell, never a host one. It runs as the box user (DIPO-334), so
 * root's processes (the keepalive and dipo's own root steps) are not read.
 */
export const TOKEN_CHECK_ENV_COMMAND: readonly [string, ...string[]] = [
  "sh",
  "-c",
  "env; cat /proc/[0-9]*/environ 2>/dev/null; exit 0",
];

export type TokenFoundIn = "environment" | "files";

/** What the check found. `hold` is true whenever the adapter must not run another box. */
export type BoxTokenCheck =
  | { readonly ok: true; readonly code: "box.tokenAbsent"; readonly hold: false }
  | {
      readonly ok: false;
      readonly code: "box.tokenFound";
      readonly hold: true;
      readonly foundIn: readonly TokenFoundIn[];
    }
  | {
      readonly ok: false;
      readonly code: "box.tokenCheckFailed";
      readonly hold: true;
      /** Which step failed, as fixed text with an error code; never text from the box. */
      readonly reason: string;
    };

export interface TokenCheckDeps {
  readonly box: Pick<BoxPort, "exec" | "exportFiles">;
  /** What knows the token: the running model proxy. */
  readonly token: TokenMatcher;
  /** The host folder the export folder is made in (under `DIPO_TMP` in tests). */
  readonly tmpRoot: string;
}

/** The error code of `error`, never its message: a message may quote the box. */
function codeOf(error: unknown): string {
  if (error instanceof BoxError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

function failed(reason: string): BoxTokenCheck {
  return { ok: false, code: "box.tokenCheckFailed", hold: true, reason };
}

async function scanFile(path: string, token: TokenMatcher): Promise<boolean> {
  const scanner = token.scanner();
  for await (const chunk of createReadStream(path)) {
    scanner.push(chunk as Uint8Array);
    if (scanner.found) return true;
  }
  return scanner.found;
}

/** True or false when the box's environment was read; a string says why it could not be. */
async function environmentHasToken(deps: TokenCheckDeps, name: string): Promise<boolean | string> {
  let environment;
  try {
    environment = await deps.box.exec(name, TOKEN_CHECK_ENV_COMMAND);
  } catch (error) {
    return `the box environment could not be read (${codeOf(error)}).`;
  }
  if (environment.code !== 0 || environment.stdout.length === 0) {
    return `the box environment could not be read (exit ${environment.code}, ${environment.stdout.length} characters).`;
  }
  const scanner = deps.token.scanner();
  scanner.push(new TextEncoder().encode(environment.stdout));
  return scanner.found;
}

/** Exports the box's files into `dir` and scans them; a string says why it could not. */
async function filesHaveToken(
  deps: TokenCheckDeps,
  name: string,
  dir: string,
): Promise<boolean | string> {
  const archive = join(dir, TOKEN_CHECK_EXPORT_FILE);
  try {
    await deps.box.exportFiles(name, archive, { timeoutMs: TOKEN_CHECK_EXPORT_TIMEOUT_MS });
  } catch (error) {
    return `the box files could not be exported (${codeOf(error)}).`;
  }
  let size: number;
  try {
    size = (await stat(archive)).size;
  } catch (error) {
    return `the box export is missing (${codeOf(error)}).`;
  }
  if (size < TAR_HEADER_BYTES) {
    return `the box export is empty or too small to be an archive (${size} bytes).`;
  }
  try {
    return await scanFile(archive, deps.token);
  } catch (error) {
    return `the box export could not be read (${codeOf(error)}).`;
  }
}

/**
 * Reports whether the token occurs in box `name`'s environment or files. Never rejects: every
 * failure, the temp folder and its removal included, is `box.tokenCheckFailed`, which holds like
 * a find, since a check that read nothing proves nothing.
 */
export async function checkBoxForToken(deps: TokenCheckDeps, name: string): Promise<BoxTokenCheck> {
  const foundIn: TokenFoundIn[] = [];
  let inEnvironment: boolean | string;
  try {
    inEnvironment = await environmentHasToken(deps, name);
  } catch (error) {
    inEnvironment = `the box environment could not be checked (${codeOf(error)}).`;
  }
  if (typeof inEnvironment === "string") return failed(inEnvironment);
  if (inEnvironment) foundIn.push("environment");

  let dir: string;
  try {
    dir = await mkdtemp(join(deps.tmpRoot, TOKEN_CHECK_DIR_PREFIX));
  } catch (error) {
    return failed(`the host folder for the box export could not be made (${codeOf(error)}).`);
  }
  let inFiles: boolean | string;
  try {
    inFiles = await filesHaveToken(deps, name, dir);
  } catch (error) {
    inFiles = `the box files could not be checked (${codeOf(error)}).`;
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    // The export may hold the token; a later start removes it with the sweep.
    return failed(`the box export could not be removed from the host (${codeOf(error)}).`);
  }
  if (typeof inFiles === "string") return failed(inFiles);
  if (inFiles) foundIn.push("files");

  return foundIn.length === 0
    ? { ok: true, code: "box.tokenAbsent", hold: false }
    : { ok: false, code: "box.tokenFound", hold: true, foundIn };
}

/**
 * Removes the export folders a check left in `tmpRoot` (a crash, a failed removal); they may hold
 * a leaked token. Never rejects; resolves to the number removed. A later start calls it.
 */
export async function sweepTokenCheckLeftovers(tmpRoot: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(tmpRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(TOKEN_CHECK_DIR_PREFIX)) continue;
    try {
      await rm(join(tmpRoot, entry), { recursive: true, force: true });
      removed += 1;
    } catch {
      // Left for the next sweep.
    }
  }
  return removed;
}

/** The launch check failure a check result holds the adapter with; null when nothing holds. */
export function tokenCheckFailure(result: BoxTokenCheck, name: string): LaunchCheckFailure | null {
  if (result.ok) return null;
  if (result.code === "box.tokenFound") {
    return {
      check: BOX_TOKEN_CHECK,
      detail: `the subscription token was found in the ${result.foundIn.join(" and ")} of box ${name} after its run`,
      fix: "Treat the token as leaked: make a new one with `claude setup-token`, store it with `dipo login box`, and find how it reached the box before running again.",
    };
  }
  return {
    check: BOX_TOKEN_CHECK,
    detail: `the check for the subscription token in box ${name} could not finish: ${result.reason}`,
    // A box-token hold is sticky (DIPO-271): a passing launch check does not lift it.
    fix: "Look at the box and the daemon log; the hold lifts once the box login is stored again with `dipo login box`.",
  };
}

export interface TokenHoldDeps extends TokenCheckDeps {
  readonly holds: Pick<AdapterHolds, "hold">;
  /** The adapter the box ran, for example the Claude worker's. */
  readonly adapter: string;
}

/**
 * The check a caller runs after a box run: it checks box `name` and, when the token was found or
 * the check could not finish, holds `adapter` through the adapter holds (no new run starts on it
 * in any office, and an `engine.notice` is raised). The check itself never rejects. DIPO-271 calls
 * it at the end of each box run.
 */
export async function checkBoxAfterRun(
  deps: TokenHoldDeps,
  name: string,
): Promise<{ readonly result: BoxTokenCheck; readonly hold: AdapterHold | null }> {
  const result = await checkBoxForToken(deps, name);
  const failure = tokenCheckFailure(result, name);
  return { result, hold: failure === null ? null : deps.holds.hold(deps.adapter, [failure]) };
}
