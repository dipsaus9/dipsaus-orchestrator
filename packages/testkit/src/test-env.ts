// Test preload (bunfig.toml, DIPO-316): before any test file loads, this test process gets the test
// marker and fresh state, log and runtime folders under `DIPO_TMP` (else `/tmp`). Code under test
// that reads `process.env`, and every child it starts with that environment, then resolves its
// `DIPO_HOME` and `DIPO_RUNTIME_DIR` here, never the real home's folders; with the marker set, dipo
// refuses those even when a test forgets an override. The folders go when the process exits, unless
// `DIPO_TEST_KEEP=1`. The per-test timeout in CI is set
// by scripts/test.ts on the command line (DIPO-335). On macOS, where `/usr/bin/git` is the developer
// tools shim that finds and starts the real git on every call, `PATH` also starts with the real git's
// own folder (a link elsewhere would lose git's templates), so the suite's many git calls skip the
// shim (DIPO-225).

import { afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** The shim git macOS puts on `PATH`: it looks up the real git on every call. */
export const MACOS_GIT_SHIM = "/usr/bin/git";

/**
 * On macOS, when the git on `env.PATH` is the shim, puts the folder of the real git (the one in
 * the shim's `--exec-path`) first on `env.PATH` and returns it. Elsewhere, or when the real git
 * cannot be found, it leaves `env` alone and returns null. The same git and developer tools run
 * either way; only the shim's lookup is skipped.
 */
export function skipGitShim(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "darwin") return null;
  const found = Bun.which("git", { PATH: env["PATH"] ?? "" });
  if (found === null || realpathSync(found) !== MACOS_GIT_SHIM) return null;
  const result = Bun.spawnSync([found, "--exec-path"], {
    env: { ...env },
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  const candidate = join(result.stdout.toString().trim(), "git");
  if (!existsSync(candidate)) return null;
  const real = realpathSync(candidate);
  if (real === MACOS_GIT_SHIM) return null;
  const bin = dirname(real);
  env["PATH"] = env["PATH"] ? `${bin}:${env["PATH"]}` : bin;
  return bin;
}

// Evaluated once per test process, as its first preload; a preload's `afterAll` runs after every
// test file.
const dirs = isolateTestProcess();
skipGitShim();
afterAll(() => {
  if (!keepTempDirs()) rmSync(dirs.root, { recursive: true, force: true });
});
