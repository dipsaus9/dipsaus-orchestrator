// Temporary directories for tests. They live under `$DIPO_TMP` when set (the sandboxed verify
// temp root, DIPO-37), else under `/tmp`, with short `dipo-XXXXXX` names because macOS limits
// Unix socket paths to about 104 bytes (0017 section 3).

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The directory every testkit temp directory is created in. */
export function tempRoot(): string {
  const configured = process.env["DIPO_TMP"];
  return configured !== undefined && configured !== "" ? configured : "/tmp";
}

/** True when `DIPO_TEST_KEEP=1` asks to keep temp directories for inspection. */
export function keepTempDirs(): boolean {
  return process.env["DIPO_TEST_KEEP"] === "1";
}

/** Creates a fresh `dipo-XXXXXX` directory under `tempRoot()` and returns its real path. */
export function makeTempDir(): string {
  const root = tempRoot();
  mkdirSync(root, { recursive: true });
  return realpathSync(mkdtempSync(join(root, "dipo-")));
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
