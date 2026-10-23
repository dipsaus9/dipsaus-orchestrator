// Software directories (0006 decision 3): the state anchor `<state>`, the logs directory and the
// runtime directory that holds the sockets. The anchor depends only on the passwd home directory,
// so every starter and client finds the same lock; the runtime directory is chosen by the daemon
// after it holds the lock, checked with `lstat`, and written to `<state>/runtime.json`.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

/** The platforms dipo runs on (0004). */
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

export type Env = Readonly<Record<string, string | undefined>>;

export function currentPlatform(platform: string = process.platform): DipoPlatform {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new Error(`dipo runs on macOS and Linux only, not on ${platform}`);
}

/** The home directory from the passwd entry for this uid, never from `$HOME`. */
export function passwdHome(): string {
  return userInfo().homedir;
}

/**
 * The test marker (DIPO-316): `DIPO_TEST=1`, set for every test process by the test runner's setup
 * file and in every test daemon's environment. With it, dipo refuses the real home's state, logs
 * and runtime folders instead of using them.
 */
export const TEST_MARKER = "DIPO_TEST";

/** True when `env` or this process's environment carries the test marker. */
export function isTestRun(env: Env): boolean {
  return env[TEST_MARKER] === "1" || process.env[TEST_MARKER] === "1";
}

/** Codes of the directory refusals (DIPO-316), dotted like the contract's error codes. */
export const DIR_ERROR_CODES = {
  /** `DIPO_HOME` names a folder dipo cannot use. */
  stateUnusable: "paths.stateDirUnusable",
  /** A test resolved the real home's state or logs folder. */
  realStateInTest: "paths.realStateInTest",
  /** `DIPO_RUNTIME_DIR` names a folder dipo cannot use. */
  runtimeUnusable: "paths.runtimeDirUnusable",
  /** A test would take one of the real runtime folders. */
  realRuntimeInTest: "paths.realRuntimeInTest",
  /** No runtime candidate and no fallback is usable. */
  noRuntimeDir: "paths.noRuntimeDir",
} as const;

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

/** The default state and logs folders of `home` on both platforms. */
function defaultDirsOf(home: string): string[] {
  return [
    join(home, "Library", "Application Support", "dipo"),
    join(home, "Library", "Logs", "dipo"),
    join(home, ".local", "state", "dipo"),
  ];
}

/** True when `path` is `dir` or inside it. */
function within(path: string, dir: string): boolean {
  const p = stripSlash(path);
  const d = stripSlash(dir);
  return p === d || p.startsWith(`${d}/`);
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
  if (!stat.isDirectory()) return "it is not a directory";
  if (uid >= 0 && stat.uid !== uid) return `it is owned by uid ${stat.uid}, not ${uid}`;
  return null;
}

/**
 * Resolves `<state>` and `<logs>` (0006 decision 3). `DIPO_HOME` replaces the anchor, for tests
 * only; its logs go to `<DIPO_HOME>/logs` on both platforms. `XDG_STATE_HOME`, `TMPDIR` and
 * `XDG_RUNTIME_DIR` are never read: they differ between a shell, launchd, systemd and SSH.
 *
 * A `DIPO_HOME` dipo cannot use (`checkStateDir`) throws `SoftwareDirError`; dipo never falls back
 * to the real folders then (DIPO-316). With the test marker, the real home's state and logs folders
 * (of the passwd home of this process, whatever `home` says) throw too.
 */
export function resolveSoftwareDirs(options: {
  readonly platform: DipoPlatform;
  readonly env: Env;
  readonly home: string;
}): SoftwareDirs {
  const dirs = softwareDirsOf(options);
  if (isTestRun(options.env)) {
    const real = defaultDirsOf(passwdHome());
    for (const path of [dirs.state, dirs.logs]) {
      if (real.some((dir) => within(path, dir) || within(dir, path))) {
        throw new SoftwareDirError(
          DIR_ERROR_CODES.realStateInTest,
          path,
          "it is the real home's dipo folder",
          `${DIR_ERROR_CODES.realStateInTest}: refusing ${path} with ${TEST_MARKER}=1: it is the real home's dipo folder. Set DIPO_HOME to a folder under DIPO_TMP.`,
        );
      }
    }
  }
  return dirs;
}

function softwareDirsOf(options: {
  readonly platform: DipoPlatform;
  readonly env: Env;
  readonly home: string;
}): SoftwareDirs {
  const { platform, env, home } = options;
  const envHome = env["HOME"];
  const homeMismatch =
    envHome !== undefined && envHome !== "" && stripSlash(envHome) !== stripSlash(home)
      ? { env: envHome, passwd: home }
      : null;
  const override = env["DIPO_HOME"];
  if (override !== undefined && override !== "") {
    const reason = checkStateDir(override);
    if (reason !== null) {
      throw new SoftwareDirError(
        DIR_ERROR_CODES.stateUnusable,
        override,
        reason,
        `${DIR_ERROR_CODES.stateUnusable}: DIPO_HOME ${override} cannot be used: ${reason}. Fix or unset DIPO_HOME; dipo does not fall back to another state folder.`,
      );
    }
    return { state: override, logs: join(override, "logs"), home, homeMismatch };
  }
  if (platform === "darwin") {
    return {
      state: join(home, "Library", "Application Support", "dipo"),
      logs: join(home, "Library", "Logs", "dipo"),
      home,
      homeMismatch,
    };
  }
  const state = join(home, ".local", "state", "dipo");
  return { state, logs: join(state, "logs"), home, homeMismatch };
}

function stripSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Longest socket path a runtime directory must hold, in bytes (0006 decision 3). */
export const RUNTIME_PATH_LIMIT = 100;
/** The longest file in the runtime directory: a worker host socket. */
export const LONGEST_RUNTIME_ENTRY = `hosts/run_${"0".repeat(26)}.sock`;
export const SOCKET_FILE = "dipo.sock";
export const RUNTIME_FILE = "runtime.json";

export type RuntimeCandidateSource = "DIPO_RUNTIME_DIR" | "XDG_RUNTIME_DIR" | "TMPDIR" | "tmp";

export interface RuntimeCandidate {
  readonly path: string;
  readonly source: RuntimeCandidateSource;
}

/**
 * The runtime directory candidates in order (0006 decision 3): `DIPO_RUNTIME_DIR`; on Linux
 * `$XDG_RUNTIME_DIR/dipo` when lingering is on, else `/tmp/dipo-<uid>`; on macOS `$TMPDIR/dipo`,
 * else `/tmp/dipo-<uid>`.
 */
export function runtimeCandidates(options: {
  readonly platform: DipoPlatform;
  readonly env: Env;
  readonly uid: number;
  /** Linux only: whether the user has lingering on (the user manager outlives logout). */
  readonly lingering: boolean;
}): RuntimeCandidate[] {
  const { platform, env, uid } = options;
  const candidates: RuntimeCandidate[] = [];
  const set = (name: string) => {
    const value = env[name];
    return value !== undefined && value !== "" ? value : undefined;
  };
  const override = set("DIPO_RUNTIME_DIR");
  if (override !== undefined) candidates.push({ path: override, source: "DIPO_RUNTIME_DIR" });
  if (platform === "linux") {
    const xdg = set("XDG_RUNTIME_DIR");
    if (xdg !== undefined && options.lingering) {
      candidates.push({ path: join(xdg, "dipo"), source: "XDG_RUNTIME_DIR" });
    }
  } else {
    const tmp = set("TMPDIR");
    if (tmp !== undefined) candidates.push({ path: join(tmp, "dipo"), source: "TMPDIR" });
  }
  candidates.push({ path: `/tmp/dipo-${uid}`, source: "tmp" });
  return candidates;
}

/** True when the user has lingering on: systemd records it as `/var/lib/systemd/linger/<user>`. */
export function lingeringEnabled(username: string = userInfo().username): boolean {
  return existsSync(join("/var/lib/systemd/linger", username));
}

/** Byte length of the longest path the runtime directory must hold. */
export function longestRuntimePathBytes(dir: string): number {
  return Buffer.byteLength(join(dir, LONGEST_RUNTIME_ENTRY));
}

/** What `lstat` saw, reduced to what the check needs; injectable for tests. */
export interface DirStat {
  readonly isSymbolicLink: boolean;
  readonly isDirectory: boolean;
  readonly uid: number;
  readonly mode: number;
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
    return `${code}: DIPO_RUNTIME_DIR ${last.path} cannot be used: ${last.reason}. Fix or unset DIPO_RUNTIME_DIR; dipo does not fall back to another runtime directory.`;
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
  const p = stripSlash(path);
  for (const uid of uids) {
    if (p === `/tmp/dipo-${uid}` || p === `/private/tmp/dipo-${uid}`) {
      return "it is the shared runtime directory of this user";
    }
  }
  for (const name of ["TMPDIR", "XDG_RUNTIME_DIR"]) {
    const value = process.env[name];
    if (value !== undefined && value !== "" && p === join(value, "dipo")) {
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
  const bytes = longestRuntimePathBytes(path);
  if (bytes > RUNTIME_PATH_LIMIT) {
    return `socket paths would be ${bytes} bytes, over the ${RUNTIME_PATH_LIMIT}-byte limit`;
  }
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
  if (stat.isSymbolicLink) return "it is a symlink";
  if (!stat.isDirectory) return "it is not a directory";
  if (stat.uid !== uid) return `it is owned by uid ${stat.uid}, not ${uid}`;
  if (stat.mode !== 0o700) return `its mode is ${stat.mode.toString(8).padStart(4, "0")}, not 0700`;
  return null;
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

/** `<state>/runtime.json`, which clients read to find the socket (0006 decision 3). */
export interface RuntimeRecord {
  readonly runtimeDir: string;
  readonly socket: string;
  readonly pid: number;
  readonly startTimeMs: number;
  readonly version: string;
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
    const value: unknown = await Bun.file(join(stateDir, RUNTIME_FILE)).json();
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as RuntimeRecord).socket === "string" &&
      typeof (value as RuntimeRecord).runtimeDir === "string" &&
      typeof (value as RuntimeRecord).pid === "number"
    ) {
      return value as RuntimeRecord;
    }
    return null;
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
