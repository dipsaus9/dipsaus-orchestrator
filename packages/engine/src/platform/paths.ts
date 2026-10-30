// Software directories (0006 decision 3): the state anchor `<state>`, the logs directory and the
// runtime directory that holds the sockets. The anchor depends only on the passwd home directory,
// so every starter and client finds the same lock; the runtime directory is chosen by the daemon
// after it holds the lock, checked with `lstat`, and written to `<state>/runtime.json`. The rules
// themselves (names, the folder rule, the checks and the records) are the contract's runtime
// layout, which the client reads too (DIPO-320); this module does the I/O.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  defaultSoftwareDirs,
  DIR_ERROR_CODES,
  type DirStat,
  type Env,
  hasTestMarker,
  inDir,
  isWithin,
  normalizePath,
  parseRuntimeRecord,
  realStateInTestMessage,
  RUNTIME_FILE,
  runtimeDirReason,
  runtimePathReason,
  type RuntimeRecord,
  runtimeUnusableMessage,
  softwareDirsOf as layoutDirsOf,
  stateDirReason,
  stateUnusableMessage,
  stripSlash,
  TEST_MARKER,
} from "@dipsaus-orchestrator/contract";

export {
  DIR_ERROR_CODES,
  type DirStat,
  type Env,
  LONGEST_RUNTIME_ENTRY,
  longestRuntimePathBytes,
  RUNTIME_FILE,
  RUNTIME_PATH_LIMIT,
  type RuntimeRecord,
  SOCKET_FILE,
  TEST_MARKER,
} from "@dipsaus-orchestrator/contract";

/**
 * The platforms dipo's process code knows: macOS, the one product platform (0004), and Linux, only
 * as the CI host for tests that need no box. The folders below are the same on both.
 */
export type DipoPlatform = "darwin" | "linux";

export interface SoftwareDirs {
  /** `<state>`: lock, `runtime.json`, `dipo.db`. */
  readonly state: string;
  /** `<logs>`: `daemon.log`. */
  readonly logs: string;
  /** The passwd home directory the anchor was resolved from. */
  readonly home: string;
  /** Set when `$HOME` differs from the passwd home; daemon and CLI log it as a warning. */
  readonly homeMismatch: { readonly env: string; readonly passwd: string } | null;
}

export function currentPlatform(platform: string = process.platform): DipoPlatform {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new Error(`dipo runs on macOS only, not on ${platform}`);
}

/** The home directory from the passwd entry for this uid, never from `$HOME`. */
export function passwdHome(): string {
  return userInfo().homedir;
}

/** True when `env` or this process's environment carries the test marker. */
export function isTestRun(env: Env): boolean {
  return hasTestMarker(env, process.env);
}

/** A state folder dipo refuses: `code` names why, `path` and `reason` what. */
export class SoftwareDirError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "SoftwareDirError";
  }
}

/**
 * Why `DIPO_HOME` cannot be used, or null: it must be absolute and, when it exists, a directory
 * this user owns. A missing one is created by the daemon.
 */
export function checkStateDir(path: string, uid: number = process.getuid?.() ?? -1): string | null {
  if (!isAbsolute(path)) return "it is not an absolute path";
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return null;
    if (code === "ENOTDIR") return "a part of it is not a directory";
    return `cannot read it: ${describe(error)}`;
  }
  return stateDirReason({ isDirectory: stat.isDirectory(), uid: stat.uid }, uid);
}

/**
 * Resolves `<state>` and `<logs>` (0005, 0006): `~/Library/Application Support/dipo` and
 * `~/Library/Logs/dipo`. `DIPO_HOME` replaces the anchor, for tests only; its logs go to
 * `<DIPO_HOME>/logs`. `TMPDIR` is never read here: it differs between a shell, launchd and SSH.
 *
 * A `DIPO_HOME` dipo cannot use (`checkStateDir`) throws `SoftwareDirError`; dipo never falls back
 * to the real folders then (DIPO-316). With the test marker, the real home's state and logs folders
 * (of the passwd home of this process, whatever `home` says) throw too.
 */
export function resolveSoftwareDirs(options: {
  readonly env: Env;
  readonly home: string;
}): SoftwareDirs {
  const dirs = softwareDirsOf(options);
  if (isTestRun(options.env)) {
    const real = Object.values(defaultSoftwareDirs(passwdHome()));
    for (const path of [dirs.state, dirs.logs]) {
      if (real.some((dir) => isWithin(path, dir) || isWithin(dir, path))) {
        throw new SoftwareDirError(
          DIR_ERROR_CODES.realStateInTest,
          path,
          "it is the real home's dipo folder",
          realStateInTestMessage(path),
        );
      }
    }
  }
  return dirs;
}

function softwareDirsOf(options: { readonly env: Env; readonly home: string }): SoftwareDirs {
  const { env, home } = options;
  const envHome = env["HOME"];
  const homeMismatch =
    envHome !== undefined && envHome !== "" && stripSlash(envHome) !== stripSlash(home)
      ? { env: envHome, passwd: home }
      : null;
  const { state, logs, override } = layoutDirsOf(env, home);
  if (override !== null) {
    const reason = checkStateDir(override);
    if (reason !== null) {
      throw new SoftwareDirError(
        DIR_ERROR_CODES.stateUnusable,
        override,
        reason,
        stateUnusableMessage(override, reason),
      );
    }
  }
  return { state, logs, home, homeMismatch };
}

export type RuntimeCandidateSource = "DIPO_RUNTIME_DIR" | "TMPDIR" | "tmp";

export interface RuntimeCandidate {
  readonly path: string;
  readonly source: RuntimeCandidateSource;
}

/**
 * The runtime directory candidates in order (0005, 0006): `DIPO_RUNTIME_DIR`, then
 * `$TMPDIR/dipo`, else `/tmp/dipo-<uid>`.
 */
export function runtimeCandidates(options: {
  readonly env: Env;
  readonly uid: number;
}): RuntimeCandidate[] {
  const { env, uid } = options;
  const candidates: RuntimeCandidate[] = [];
  const set = (name: string) => {
    const value = env[name];
    return value !== undefined && value !== "" ? value : undefined;
  };
  const override = set("DIPO_RUNTIME_DIR");
  if (override !== undefined) candidates.push({ path: override, source: "DIPO_RUNTIME_DIR" });
  const tmp = set("TMPDIR");
  if (tmp !== undefined) candidates.push({ path: join(tmp, "dipo"), source: "TMPDIR" });
  candidates.push({ path: `/tmp/dipo-${uid}`, source: "tmp" });
  return candidates;
}

export interface RuntimeDirFs {
  /** `lstat` without following a symlink; null when the path does not exist. */
  lstat(path: string): DirStat | null;
  /** Creates one directory with mode 0700; throws `EEXIST` when it exists. */
  mkdir(path: string): void;
  /** Creates a fresh `<prefix>XXXXXX` directory (mode 0700) and returns its path. */
  mkdtemp(prefix: string): string;
}

export const systemRuntimeDirFs: RuntimeDirFs = {
  lstat: (path) => {
    try {
      const stat = lstatSync(path);
      return {
        isSymbolicLink: stat.isSymbolicLink(),
        isDirectory: stat.isDirectory(),
        uid: stat.uid,
        mode: stat.mode & 0o777,
      };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  },
  // `mode` is reduced by the umask; the check below then rejects anything but 0700, which only a
  // umask of 077 or looser leaves. The common 022 and 077 both give 0700.
  mkdir: (path) => mkdirSync(path, { mode: 0o700 }),
  mkdtemp: (prefix) => mkdtempSync(prefix),
};

export interface RejectedRuntimeDir {
  readonly path: string;
  readonly reason: string;
}

export interface RuntimeDirChoice {
  readonly path: string;
  readonly source: RuntimeCandidateSource | "mkdtemp";
  /** Candidates passed over, in order, with the reason; the daemon logs each one. */
  readonly rejected: readonly RejectedRuntimeDir[];
}

export class RuntimeDirError extends Error {
  constructor(
    readonly rejected: readonly RejectedRuntimeDir[],
    readonly code: string = DIR_ERROR_CODES.noRuntimeDir,
  ) {
    super(runtimeDirMessage(code, rejected));
    this.name = "RuntimeDirError";
  }
}

function runtimeDirMessage(code: string, rejected: readonly RejectedRuntimeDir[]): string {
  const last = rejected.at(-1);
  if (code === DIR_ERROR_CODES.runtimeUnusable && last !== undefined) {
    return runtimeUnusableMessage(last.path, last.reason);
  }
  if (code === DIR_ERROR_CODES.realRuntimeInTest && last !== undefined) {
    return `${code}: refusing runtime directory ${last.path} with ${TEST_MARKER}=1: ${last.reason}. Set DIPO_RUNTIME_DIR to a folder under DIPO_TMP.`;
  }
  return `${code}: No usable runtime directory: ${rejected.map((r) => `${r.path} (${r.reason})`).join("; ")}. Remove or fix the squatted path, or set DIPO_RUNTIME_DIR to a directory you own with mode 0700.`;
}

/** The macOS per-user temp folder's `dipo`: `/var/folders/<xx>/<id>/T/dipo`. */
const MACOS_USER_TMP_DIPO = /^(\/private)?\/var\/folders\/[^/]+\/[^/]+\/T\/dipo$/;

/**
 * Why `path` is one of the real runtime folders a live daemon may use, or null (DIPO-316):
 * `/tmp/dipo-<uid>`, `$TMPDIR/dipo` and `$XDG_RUNTIME_DIR/dipo` of this process, and the macOS
 * per-user temp folder's `dipo`.
 */
export function realRuntimeDirReason(path: string, uids: readonly number[]): string | null {
  // Normalised, so `/tmp/x/../dipo-501` is the real folder it names (DIPO-320).
  const p = normalizePath(path);
  for (const uid of uids) {
    if (p === `/tmp/dipo-${uid}` || p === `/private/tmp/dipo-${uid}`) {
      return "it is the shared runtime directory of this user";
    }
  }
  for (const name of ["TMPDIR", "XDG_RUNTIME_DIR"]) {
    const value = process.env[name];
    if (value !== undefined && value !== "" && p === inDir(value, "dipo")) {
      return `it is ${name}/dipo, a real runtime directory`;
    }
  }
  if (MACOS_USER_TMP_DIPO.test(p)) return "it is the user temp folder's dipo directory";
  return null;
}

/**
 * Checks one candidate: it must fit the path limit, and after creating it when missing it must be
 * a real directory (no symlink), owned by `uid`, with mode 0700. Returns the reason it is
 * rejected, or null when it is usable.
 */
export function checkRuntimeDir(path: string, uid: number, fs: RuntimeDirFs): string | null {
  const tooLong = runtimePathReason(path);
  if (tooLong !== null) return tooLong;
  if (fs.lstat(path) === null) {
    try {
      fs.mkdir(path);
    } catch (error) {
      // EEXIST: created in between; the lstat below checks what is there now.
      if (errorCode(error) !== "EEXIST") return `cannot create it: ${describe(error)}`;
    }
  }
  const stat = fs.lstat(path);
  if (stat === null) return "it vanished after it was created";
  return runtimeDirReason(stat, uid);
}

/**
 * Chooses the runtime directory (0006 decision 3): the first candidate that passes
 * `checkRuntimeDir`, else a fresh `mkdtemp` directory under `tmpBase`. Throws `RuntimeDirError`
 * naming every rejected path when the fallback fails too.
 */
export function chooseRuntimeDir(options: {
  readonly candidates: readonly RuntimeCandidate[];
  readonly uid: number;
  /** Where the `mkdtemp` fallback goes: `/tmp`, or `DIPO_TMP` in tests. */
  readonly tmpBase: string;
  readonly fs?: RuntimeDirFs;
  /** The daemon's environment, read for the test marker only (DIPO-316). */
  readonly env?: Env;
}): RuntimeDirChoice {
  const fs = options.fs ?? systemRuntimeDirFs;
  const rejected: RejectedRuntimeDir[] = [];
  const test = isTestRun(options.env ?? {});
  const uids = [...new Set([options.uid, process.getuid?.() ?? -1])];
  for (const candidate of options.candidates) {
    // With the test marker a real runtime folder is refused before it is touched (DIPO-316).
    const real = test ? realRuntimeDirReason(candidate.path, uids) : null;
    if (real !== null) {
      rejected.push({ path: candidate.path, reason: real });
      throw new RuntimeDirError(rejected, DIR_ERROR_CODES.realRuntimeInTest);
    }
    const reason = checkRuntimeDir(candidate.path, options.uid, fs);
    if (reason === null) return { path: candidate.path, source: candidate.source, rejected };
    rejected.push({ path: candidate.path, reason });
    // An override dipo cannot use stops the start; it never falls through (DIPO-316).
    if (candidate.source === "DIPO_RUNTIME_DIR") {
      throw new RuntimeDirError(rejected, DIR_ERROR_CODES.runtimeUnusable);
    }
  }
  let fallback: string;
  try {
    fallback = fs.mkdtemp(join(options.tmpBase, "dipo-"));
  } catch (error) {
    rejected.push({ path: join(options.tmpBase, "dipo-XXXXXX"), reason: describe(error) });
    throw new RuntimeDirError(rejected);
  }
  const reason = checkRuntimeDir(fallback, options.uid, fs);
  if (reason !== null) {
    rejected.push({ path: fallback, reason });
    throw new RuntimeDirError(rejected);
  }
  return { path: fallback, source: "mkdtemp", rejected };
}

/** Writes `<state>/runtime.json` by write-to-temp then rename, mode 0600. */
export function writeRuntimeRecord(stateDir: string, record: RuntimeRecord): void {
  const path = join(stateDir, RUNTIME_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Reads `<state>/runtime.json`; null when it is missing or not a runtime record. */
export async function readRuntimeRecord(stateDir: string): Promise<RuntimeRecord | null> {
  try {
    return parseRuntimeRecord(await Bun.file(join(stateDir, RUNTIME_FILE)).json());
  } catch {
    return null;
  }
}

/** Creates a directory and its parents with mode 0700, and sets 0700 on the last one. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
