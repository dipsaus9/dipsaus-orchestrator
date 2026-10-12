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
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

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
 * Resolves `<state>` and `<logs>` (0006 decision 3). `DIPO_HOME` replaces the anchor, for tests
 * only; its logs go to `<DIPO_HOME>/logs` on both platforms. `XDG_STATE_HOME`, `TMPDIR` and
 * `XDG_RUNTIME_DIR` are never read: they differ between a shell, launchd, systemd and SSH.
 */
export function resolveSoftwareDirs(options: {
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
  constructor(readonly rejected: readonly RejectedRuntimeDir[]) {
    super(
      `No usable runtime directory: ${rejected.map((r) => `${r.path} (${r.reason})`).join("; ")}. Remove or fix the squatted path, or set DIPO_RUNTIME_DIR to a directory you own with mode 0700.`,
    );
    this.name = "RuntimeDirError";
  }
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
}): RuntimeDirChoice {
  const fs = options.fs ?? systemRuntimeDirFs;
  const rejected: RejectedRuntimeDir[] = [];
  for (const candidate of options.candidates) {
    const reason = checkRuntimeDir(candidate.path, options.uid, fs);
    if (reason === null) return { path: candidate.path, source: candidate.source, rejected };
    rejected.push({ path: candidate.path, reason });
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
