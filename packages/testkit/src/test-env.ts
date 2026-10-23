// Test preload (bunfig.toml, DIPO-316): before any test file loads, this test process gets the test
// marker and fresh state, log and runtime folders under `DIPO_TMP` (else `/tmp`). Code under test
// that reads `process.env`, and every child it starts with that environment, then resolves its
// `DIPO_HOME` and `DIPO_RUNTIME_DIR` here, never the real home's folders; with the marker set, dipo
// refuses those even when a test forgets an override. The folders go when the process exits, unless
// `DIPO_TEST_KEEP=1`.

import { afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { TEST_MARKER, testRuntimeDir, testStateDir } from "./runtime";
import { keepTempDirs, tempRoot } from "./temp";

/** The folders `isolateTestProcess` set. */
export interface TestProcessDirs {
  readonly root: string;
  readonly state: string;
  readonly logs: string;
  readonly runtime: string;
}

/** A private directory (mode 0700, as the daemon's runtime check wants), created fresh. */
function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/**
 * Sets the test marker, `DIPO_HOME` and `DIPO_RUNTIME_DIR` in `env` to fresh folders in a new
 * `dipo-XXXXXX` directory under the temp root, and returns them.
 */
export function isolateTestProcess(env: NodeJS.ProcessEnv = process.env): TestProcessDirs {
  const root = realpathSync(mkdtempSync(join(tempRoot(), "dipo-")));
  const state = privateDir(testStateDir(root));
  const logs = privateDir(join(state, "logs"));
  const runtime = privateDir(testRuntimeDir(root));
  env[TEST_MARKER] = "1";
  env["DIPO_HOME"] = state;
  env["DIPO_RUNTIME_DIR"] = runtime;
  return { root, state, logs, runtime };
}

// Evaluated once per test process, as its first preload; a preload's `afterAll` runs after every
// test file.
const dirs = isolateTestProcess();
afterAll(() => {
  if (!keepTempDirs()) rmSync(dirs.root, { recursive: true, force: true });
});
