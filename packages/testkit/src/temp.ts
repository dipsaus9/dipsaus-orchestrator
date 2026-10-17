// Temporary directories for tests. They live under `$DIPO_TMP` when set (the sandboxed verify
// temp root, DIPO-37), else under `/tmp`, with short `dipo-XXXXXX` names because macOS limits
// Unix socket paths to about 104 bytes (0017 section 3). A temp root too long for a test daemon's
// socket paths is refused (DIPO-109): the daemon would otherwise fall back to the real runtime
// directory and remove a live daemon's socket.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  assertTestRuntimeDir,
  longestTestSocketBytes,
  MAX_TEMP_ROOT_BYTES,
  RUNTIME_PATH_LIMIT,
  TEMP_DIR_TEMPLATE,
} from "./runtime";

/**
 * Whether a temp root at `root` is accepted: its test directories' socket paths all fit the limit.
 * Checks the path only, so a computed path can be tested without creating it (DIPO-191).
 */
export function tempRootFits(root: string): boolean {
  return longestTestSocketBytes(join(root, TEMP_DIR_TEMPLATE)) <= RUNTIME_PATH_LIMIT;
}

/**
 * The directory every testkit temp directory is created in. Creates it, and throws when a test
 * daemon's socket paths under it would pass the Unix socket path limit.
 */
export function tempRoot(): string {
  const configured = process.env["DIPO_TMP"];
  const root = configured !== undefined && configured !== "" ? configured : "/tmp";
  mkdirSync(root, { recursive: true });
  const real = realpathSync(root);
  if (!tempRootFits(real)) {
    const bytes = longestTestSocketBytes(join(real, TEMP_DIR_TEMPLATE));
    throw new Error(
      `DIPO_TMP ${root} (${real}) is too long: a test daemon's socket paths under it would be ${bytes} bytes, over the ${RUNTIME_PATH_LIMIT}-byte Unix socket path limit, and the daemon would fall back to the real runtime directory. Set DIPO_TMP to a directory of at most ${MAX_TEMP_ROOT_BYTES} bytes after symlinks, such as /tmp/dt, or leave it unset.`,
    );
  }
  return root;
}

/** True when `DIPO_TEST_KEEP=1` asks to keep temp directories for inspection. */
export function keepTempDirs(): boolean {
  return process.env["DIPO_TEST_KEEP"] === "1";
}

/** Creates a fresh `dipo-XXXXXX` directory under `tempRoot()` and returns its real path. */
export function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(tempRoot(), "dipo-")));
}

/** Removes `dir` unless `DIPO_TEST_KEEP=1`, in which case it reports where the directory is. */
export function removeTempDir(dir: string): void {
  if (keepTempDirs()) {
    console.error(`DIPO_TEST_KEEP=1: kept ${dir}`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Runs `fn` with a fresh temp directory and removes it in a `finally`. */
export async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = makeTempDir();
  try {
    return await fn(dir);
  } finally {
    removeTempDir(dir);
  }
}

/**
 * `withTempDir` for a test that starts a daemon with `isolatedDaemonEnv(dir)`: once `fn` is done,
 * passed or failed, the test fails when the daemon log shows a runtime directory other than its
 * `DIPO_RUNTIME_DIR`.
 */
export async function withDaemonTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    try {
      return await fn(dir);
    } finally {
      assertTestRuntimeDir(dir);
    }
  });
}
