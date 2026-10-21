// The post-run token check (0021 section 16, line 9, DIPO-269): after a run, dipo looks for the
// maintainer's subscription token in the box's environment and files. The token never goes into
// the box for this; dipo takes the box's environment and an archive of its files out through the
// box interface and compares them in memory with a `TokenMatcher` (the model proxy). The result
// says only where the token was found, never the token, and holds the adapter when the token was
// found or the check could not prove anything.

import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { BOX_PACKAGE_CACHE_PATH, type BoxPort } from "./port";
import type { TokenMatcher } from "./token";

/** Where the file archive is made inside the box; it is left out of itself and removed after. */
export const TOKEN_CHECK_ARCHIVE = "/tmp/dipo-token-check.tar";

/**
 * Prints the box's own environment and that of every process still running in it (NUL-separated
 * in /proc); the box's shell, never a host one.
 */
export const TOKEN_CHECK_ENV_COMMAND: readonly [string, ...string[]] = [
  "sh",
  "-c",
  "env; cat /proc/[0-9]*/environ 2>/dev/null; exit 0",
];

/**
 * Archives the box's whole filesystem, uncompressed so a file's bytes stay contiguous. Left out:
 * the kernel's pseudo filesystems, the archive itself, and the office package cache, which is
 * mounted read-only from the host and so cannot carry anything from the box.
 */
export const TOKEN_CHECK_ARCHIVE_COMMAND: readonly [string, ...string[]] = [
  "tar",
  "-cf",
  TOKEN_CHECK_ARCHIVE,
  "--exclude=./proc",
  "--exclude=./sys",
  "--exclude=./dev",
  `--exclude=.${TOKEN_CHECK_ARCHIVE}`,
  `--exclude=.${BOX_PACKAGE_CACHE_PATH}`,
  "-C",
  "/",
  ".",
];

/** How long the archive may take; a box holds a whole toolchain. */
export const TOKEN_CHECK_ARCHIVE_TIMEOUT_MS = 10 * 60_000;

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
      /** Why the check proves nothing; the token never appears in it. */
      readonly reason: string;
    };

export interface TokenCheckDeps {
  readonly box: Pick<BoxPort, "exec" | "copyOut">;
  /** What knows the token: the running model proxy. */
  readonly token: TokenMatcher;
  /** The host folder the archive is copied into (under `DIPO_TMP` in tests); removed after. */
  readonly tmpRoot: string;
}

async function scanFile(path: string, token: TokenMatcher): Promise<boolean> {
  const scanner = token.scanner();
  for await (const chunk of createReadStream(path)) {
    scanner.push(chunk as Uint8Array);
    if (scanner.found) return true;
  }
  return scanner.found;
}

function failed(token: TokenMatcher, reason: string): BoxTokenCheck {
  return { ok: false, code: "box.tokenCheckFailed", hold: true, reason: token.redact(reason) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reports whether the token occurs in box `name`'s environment or files. The box must be running.
 * Any step that fails makes the result `box.tokenCheckFailed`, which holds like a find: a check
 * that read nothing proves nothing.
 */
export async function checkBoxForToken(deps: TokenCheckDeps, name: string): Promise<BoxTokenCheck> {
  const { box, token } = deps;
  const foundIn: TokenFoundIn[] = [];

  let environment;
  try {
    environment = await box.exec(name, TOKEN_CHECK_ENV_COMMAND);
  } catch (error) {
    return failed(token, `the box environment could not be read: ${messageOf(error)}`);
  }
  if (environment.code !== 0 || environment.stdout.length === 0) {
    return failed(token, `the box environment could not be read (exit ${environment.code}).`);
  }
  const envScanner = token.scanner();
  envScanner.push(new TextEncoder().encode(environment.stdout));
  if (envScanner.found) foundIn.push("environment");

  const hostDir = await mkdtemp(join(deps.tmpRoot, "dipo-token-check-"));
  try {
    let archived;
    try {
      archived = await box.exec(name, TOKEN_CHECK_ARCHIVE_COMMAND, {
        timeoutMs: TOKEN_CHECK_ARCHIVE_TIMEOUT_MS,
      });
    } catch (error) {
      return failed(token, `the box files could not be archived: ${messageOf(error)}`);
    }
    if (archived.code !== 0) {
      const said = archived.stderr.trim().split("\n")[0] ?? "";
      return failed(
        token,
        `the box files could not be archived (exit ${archived.code})${said === "" ? "" : `: ${said}`}`,
      );
    }
    const hostArchive = join(hostDir, "box.tar");
    try {
      await box.copyOut(name, TOKEN_CHECK_ARCHIVE, hostArchive, {
        timeoutMs: TOKEN_CHECK_ARCHIVE_TIMEOUT_MS,
      });
      if (await scanFile(hostArchive, token)) foundIn.push("files");
    } catch (error) {
      return failed(token, `the box files could not be read: ${messageOf(error)}`);
    }
  } finally {
    await rm(hostDir, { recursive: true, force: true });
    // The archive in the box is the box's own business; a failure to remove it is not a finding.
    await box.exec(name, ["rm", "-f", TOKEN_CHECK_ARCHIVE]).catch(() => undefined);
  }

  return foundIn.length === 0
    ? { ok: true, code: "box.tokenAbsent", hold: false }
    : { ok: false, code: "box.tokenFound", hold: true, foundIn };
}
