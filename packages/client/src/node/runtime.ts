// Where a client finds the daemon (0006 decision 3): the state anchor `<state>` and the
// `<state>/runtime.json` the daemon writes after it holds the lock. The anchor rule is the same as
// the daemon's: `DIPO_HOME` (tests only), else a fixed path under the passwd home directory, never
// `$HOME`, `XDG_STATE_HOME` or `TMPDIR`, so every client finds the daemon's file. `client` may not
// import `engine` (0004), so the rule is repeated here; both sides are tested against the same
// paths. Telling a stale record from a live daemon (`dipo.pid`, start time) is the lifecycle
// module's job (DIPO-70); here a record whose socket does not answer means no daemon.
//
// A `DIPO_HOME` or `DIPO_RUNTIME_DIR` dipo cannot use, and with the test marker `DIPO_TEST=1` the
// real home's state folder, are refused with a coded error (DIPO-316), never passed over. The codes,
// the marker and the runtime path limit are copies of the engine's (`platform/paths.ts`).

import { lstatSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

export const RUNTIME_FILE = "runtime.json";

/** The test marker (engine `TEST_MARKER`). */
export const TEST_MARKER = "DIPO_TEST";
/** Longest socket path a runtime directory must hold (engine `RUNTIME_PATH_LIMIT`). */
const RUNTIME_PATH_LIMIT = 100;
/** The longest file in a runtime directory (engine `LONGEST_RUNTIME_ENTRY`). */
const LONGEST_RUNTIME_ENTRY = `hosts/run_${"0".repeat(26)}.sock`;

/** A state or runtime folder dipo refuses (DIPO-316); `code` is the engine's. */
export class DirRefusedError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "DirRefusedError";
  }
}

function isTestRun(env: Env): boolean {
  return env[TEST_MARKER] === "1" || process.env[TEST_MARKER] === "1";
}

function stripSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function within(path: string, dir: string): boolean {
  const p = stripSlash(path);
  const d = stripSlash(dir);
  return p === d || p.startsWith(`${d}/`);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const uidNow = (): number => process.getuid?.() ?? -1;

/** Why `DIPO_HOME` cannot be used, or null; the engine's `checkStateDir`. */
function stateDirReason(path: string): string | null {
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
  const uid = uidNow();
  if (uid >= 0 && stat.uid !== uid) return `it is owned by uid ${stat.uid}, not ${uid}`;
  return null;
}

/**
 * Why `DIPO_RUNTIME_DIR` cannot be used, or null, as far as a client can tell without creating it:
 * absolute, short enough for every socket path, and when it exists a real directory this user owns
 * with mode 0700. The daemon checks the rest when it creates it.
 */
function runtimeDirReason(path: string): string | null {
  if (!isAbsolute(path)) return "it is not an absolute path";
  const bytes = Buffer.byteLength(join(path, LONGEST_RUNTIME_ENTRY));
  if (bytes > RUNTIME_PATH_LIMIT) {
    return `socket paths would be ${bytes} bytes, over the ${RUNTIME_PATH_LIMIT}-byte limit`;
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return null;
    if (code === "ENOTDIR") return "a part of it is not a directory";
    return `cannot read it: ${describe(error)}`;
  }
  if (stat.isSymbolicLink()) return "it is a symlink";
  if (!stat.isDirectory()) return "it is not a directory";
  const uid = uidNow();
  if (uid >= 0 && stat.uid !== uid) return `it is owned by uid ${stat.uid}, not ${uid}`;
  const mode = stat.mode & 0o777;
  if (mode !== 0o700) return `its mode is ${mode.toString(8).padStart(4, "0")}, not 0700`;
  return null;
}

function defaultStateDir(platform: string, home: string): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "dipo");
  return join(home, ".local", "state", "dipo");
}

/** The real home's dipo folders on both platforms (of the passwd home of this process). */
function realDirs(): string[] {
  const home = userInfo().homedir;
  return [
    join(home, "Library", "Application Support", "dipo"),
    join(home, "Library", "Logs", "dipo"),
    join(home, ".local", "state", "dipo"),
  ];
}

/** The state anchor, or the refusal of an override dipo cannot use, or of the real one in a test. */
function resolveState(env: Env, platform: string, home: string): string | DirRefusedError {
  const override = env["DIPO_HOME"];
  let state: string;
  if (override !== undefined && override !== "") {
    const reason = stateDirReason(override);
    if (reason !== null) {
      return new DirRefusedError(
        "paths.stateDirUnusable",
        override,
        reason,
        `paths.stateDirUnusable: DIPO_HOME ${override} cannot be used: ${reason}. Fix or unset DIPO_HOME; dipo does not fall back to another state folder.`,
      );
    }
    state = override;
  } else {
    state = defaultStateDir(platform, home);
  }
  if (isTestRun(env)) {
    for (const path of [state, join(state, "logs")]) {
      if (realDirs().some((dir) => within(path, dir) || within(dir, path))) {
        return new DirRefusedError(
          "paths.realStateInTest",
          path,
          "it is the real home's dipo folder",
          `paths.realStateInTest: refusing ${path} with ${TEST_MARKER}=1: it is the real home's dipo folder. Set DIPO_HOME to a folder under DIPO_TMP.`,
        );
      }
    }
  }
  return state;
}

/**
 * The refusal of the state or runtime folder overrides in `env` (DIPO-316), or null when both can
 * be used. Every command but `--help`, `--version` and the daemon's internal forms checks it
 * first and stops with the coded error; `stateDir` and `logsDir` throw it.
 */
export function dirRefusal(
  env: Env = process.env,
  platform: string = process.platform,
  home: string = userInfo().homedir,
): DirRefusedError | null {
  const state = resolveState(env, platform, home);
  if (state instanceof DirRefusedError) return state;
  const runtime = env["DIPO_RUNTIME_DIR"];
  if (runtime !== undefined && runtime !== "") {
    const reason = runtimeDirReason(runtime);
    if (reason !== null) {
      return new DirRefusedError(
        "paths.runtimeDirUnusable",
        runtime,
        reason,
        `paths.runtimeDirUnusable: DIPO_RUNTIME_DIR ${runtime} cannot be used: ${reason}. Fix or unset DIPO_RUNTIME_DIR; dipo does not fall back to another runtime directory.`,
      );
    }
  }
  return null;
}

/** `<state>` for this user (0006 decision 3); throws `DirRefusedError` for a refused folder. */
export function stateDir(
  env: Env = process.env,
  platform: string = process.platform,
  home: string = userInfo().homedir,
): string {
  const state = resolveState(env, platform, home);
  if (state instanceof DirRefusedError) throw state;
  return state;
}

/** `<logs>`, where `daemon.log` is (0006 decision 3); `DIPO_HOME` puts it in `<DIPO_HOME>/logs`. */
export function logsDir(
  env: Env = process.env,
  platform: string = process.platform,
  home: string = userInfo().homedir,
): string {
  const state = stateDir(env, platform, home);
  const override = env["DIPO_HOME"];
  if (override !== undefined && override !== "") return join(override, "logs");
  if (platform === "darwin") return join(home, "Library", "Logs", "dipo");
  return join(state, "logs");
}

/** The fields of `<state>/runtime.json` a client uses. */
export interface RuntimeInfo {
  readonly runtimeDir: string;
  readonly socket: string;
  readonly pid: number;
  readonly startTimeMs: number;
  readonly version: string;
}

/** Reads `<state>/runtime.json`; null when it is missing or not a runtime record. */
export function readRuntimeInfo(state: string): RuntimeInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(state, RUNTIME_FILE), "utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<Record<keyof RuntimeInfo, unknown>>;
  if (
    typeof record.socket !== "string" ||
    !record.socket.startsWith("/") ||
    typeof record.runtimeDir !== "string" ||
    typeof record.pid !== "number" ||
    typeof record.startTimeMs !== "number" ||
    typeof record.version !== "string"
  ) {
    return null;
  }
  return {
    runtimeDir: record.runtimeDir,
    socket: record.socket,
    pid: record.pid,
    startTimeMs: record.startTimeMs,
    version: record.version,
  };
}
