// Where a client finds the daemon (0006 decision 3): the state anchor `<state>` and the
// `<state>/runtime.json` the daemon writes after it holds the lock. The anchor rule, the folder
// checks and the record are the contract's runtime layout, the daemon's own (DIPO-320): `DIPO_HOME`
// (tests only), else a fixed path under the passwd home directory, never `$HOME`,
// `XDG_STATE_HOME` or `TMPDIR`, so every client finds the daemon's file. Telling a stale record
// from a live daemon (`dipo.pid`, start time) is the lifecycle module's job (DIPO-70); here a
// record whose socket does not answer means no daemon.
//
// A `DIPO_HOME` or `DIPO_RUNTIME_DIR` dipo cannot use, and with the test marker `DIPO_TEST=1` the
// real home's state folder, are refused with a coded error (DIPO-316), never passed over.

import { lstatSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  defaultSoftwareDirs,
  DIR_ERROR_CODES,
  type Env,
  hasTestMarker,
  isWithin,
  parseRuntimeRecord,
  realStateInTestMessage,
  RUNTIME_FILE,
  runtimeDirReason as layoutRuntimeDirReason,
  runtimePathReason,
  type RuntimeRecord,
  runtimeUnusableMessage,
  softwareDirsOf,
  stateDirReason as layoutStateDirReason,
  stateUnusableMessage,
} from "@dipsaus-orchestrator/contract";

export { type Env, RUNTIME_FILE, TEST_MARKER } from "@dipsaus-orchestrator/contract";

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
  return hasTestMarker(env, process.env);
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
  return layoutStateDirReason({ isDirectory: stat.isDirectory(), uid: stat.uid }, uidNow());
}

/**
 * Why `DIPO_RUNTIME_DIR` cannot be used, or null, as far as a client can tell without creating it:
 * absolute, short enough for every socket path, and when it exists a real directory this user owns
 * with mode 0700. The daemon checks the rest when it creates it.
 */
function runtimeDirReason(path: string): string | null {
  if (!isAbsolute(path)) return "it is not an absolute path";
  const tooLong = runtimePathReason(path);
  if (tooLong !== null) return tooLong;
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return null;
    if (code === "ENOTDIR") return "a part of it is not a directory";
    return `cannot read it: ${describe(error)}`;
  }
  return layoutRuntimeDirReason(
    {
      isSymbolicLink: stat.isSymbolicLink(),
      isDirectory: stat.isDirectory(),
      uid: stat.uid,
      mode: stat.mode & 0o777,
    },
    uidNow(),
  );
}

/** The real home's dipo folders (of the passwd home of this process). */
function realDirs(): string[] {
  return Object.values(defaultSoftwareDirs(userInfo().homedir));
}

/** The state anchor, or the refusal of an override dipo cannot use, or of the real one in a test. */
function resolveState(env: Env, home: string): string | DirRefusedError {
  const { state, override } = softwareDirsOf(env, home);
  if (override !== null) {
    const reason = stateDirReason(override);
    if (reason !== null) {
      return new DirRefusedError(
        DIR_ERROR_CODES.stateUnusable,
        override,
        reason,
        stateUnusableMessage(override, reason),
      );
    }
  }
  if (isTestRun(env)) {
    for (const path of [state, join(state, "logs")]) {
      if (realDirs().some((dir) => isWithin(path, dir) || isWithin(dir, path))) {
        return new DirRefusedError(
          DIR_ERROR_CODES.realStateInTest,
          path,
          "it is the real home's dipo folder",
          realStateInTestMessage(path),
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
  home: string = userInfo().homedir,
): DirRefusedError | null {
  const state = resolveState(env, home);
  if (state instanceof DirRefusedError) return state;
  const runtime = env["DIPO_RUNTIME_DIR"];
  if (runtime !== undefined && runtime !== "") {
    const reason = runtimeDirReason(runtime);
    if (reason !== null) {
      return new DirRefusedError(
        DIR_ERROR_CODES.runtimeUnusable,
        runtime,
        reason,
        runtimeUnusableMessage(runtime, reason),
      );
    }
  }
  return null;
}

/** `<state>` for this user (0006 decision 3); throws `DirRefusedError` for a refused folder. */
export function stateDir(env: Env = process.env, home: string = userInfo().homedir): string {
  const state = resolveState(env, home);
  if (state instanceof DirRefusedError) throw state;
  return state;
}

/** `<logs>`, where `daemon.log` is (0006 decision 3); `DIPO_HOME` puts it in `<DIPO_HOME>/logs`. */
export function logsDir(env: Env = process.env, home: string = userInfo().homedir): string {
  stateDir(env, home);
  return softwareDirsOf(env, home).logs;
}

/** The fields of `<state>/runtime.json` a client uses. */
export type RuntimeInfo = RuntimeRecord;

/** Reads `<state>/runtime.json`; null when it is missing or not a runtime record. */
export function readRuntimeInfo(state: string): RuntimeInfo | null {
  try {
    return parseRuntimeRecord(JSON.parse(readFileSync(join(state, RUNTIME_FILE), "utf8")));
  } catch {
    return null;
  }
}
