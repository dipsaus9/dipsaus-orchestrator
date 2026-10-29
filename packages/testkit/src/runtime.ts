// The runtime directory of a test daemon (DIPO-109). A daemon takes the first usable candidate of
// `DIPO_RUNTIME_DIR`, `$TMPDIR/dipo` and `/tmp/dipo-<uid>`, and removes the `dipo.sock` it finds
// there (0006 decision 3). A test daemon whose candidates under its temp directory are too long for
// a socket path would fall back to the maintainer's real runtime directory and remove a live
// daemon's socket. So a test daemon gets both variables under its temp directory, `tempRoot()` refuses a `DIPO_TMP` too long for them,
// and a test fails when the daemon logs any other runtime directory.
//
// testkit may not import engine (0004), so the two limits below are copies of
// `RUNTIME_PATH_LIMIT` and `LONGEST_RUNTIME_ENTRY` in packages/engine/src/platform/paths.ts;
// packages/daemon/test/unit/runtime-isolation.test.ts keeps them equal.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Longest socket path a runtime directory must hold, in bytes (engine `RUNTIME_PATH_LIMIT`). */
export const RUNTIME_PATH_LIMIT = 100;
/** The longest file in a runtime directory (engine `LONGEST_RUNTIME_ENTRY`). */
export const LONGEST_RUNTIME_ENTRY = `hosts/run_${"0".repeat(26)}.sock`;

/** The name pattern of a testkit temp directory; `XXXXXX` is as long as what mkdtemp puts there. */
export const TEMP_DIR_TEMPLATE = "dipo-XXXXXX";

/** The test marker (engine `TEST_MARKER`): with it, dipo refuses the real home's folders (DIPO-316). */
export const TEST_MARKER = "DIPO_TEST";

/** The only runtime directory source a test daemon may report. */
export const TEST_RUNTIME_SOURCE = "DIPO_RUNTIME_DIR";

/** The daemon's log message that names the runtime directory it chose and why. */
export const RUNTIME_CHOSEN_MESSAGE = "runtime directory chosen";

/** `DIPO_RUNTIME_DIR` of a test daemon: `<dir>/run`. */
export function testRuntimeDir(dir: string): string {
  return join(dir, "run");
}

/** `TMPDIR` of a test daemon: `<dir>/tmp`, where it finds `<dir>/tmp/dipo`. */
export function testTmpDir(dir: string): string {
  return join(dir, "tmp");
}

/** `DIPO_HOME` of a test daemon: `<dir>/state`; its log is `<dir>/state/logs/daemon.log`. */
export function testStateDir(dir: string): string {
  return join(dir, "state");
}

/** Every runtime directory candidate under `dir` that a test daemon can take, in daemon order. */
export function testRuntimeCandidates(dir: string): string[] {
  return [testRuntimeDir(dir), join(testTmpDir(dir), "dipo")];
}

/** Byte length of the longest socket path a test daemon in `dir` can bind. */
export function longestTestSocketBytes(dir: string): number {
  return Math.max(
    ...testRuntimeCandidates(dir).map((path) =>
      Buffer.byteLength(join(path, LONGEST_RUNTIME_ENTRY)),
    ),
  );
}

/**
 * The longest temp root (after symlinks) whose testkit temp directories still hold every test
 * socket path: 37 bytes with the names above.
 */
export const MAX_TEMP_ROOT_BYTES =
  RUNTIME_PATH_LIMIT - longestTestSocketBytes(join("/", TEMP_DIR_TEMPLATE));

/**
 * The state, runtime and temp variables of a test daemon in `dir`, all under `dir`: `DIPO_HOME`,
 * `DIPO_RUNTIME_DIR`, `TMPDIR` and `DIPO_TMP`, with the test marker. Creates
 * `<dir>/tmp` (mode 0700). A `DIPO_RUNTIME_DIR` the daemon cannot use stops it (DIPO-316).
 */
export function isolatedDaemonEnv(dir: string): {
  DIPO_TEST: "1";
  DIPO_HOME: string;
  DIPO_RUNTIME_DIR: string;
  TMPDIR: string;
  DIPO_TMP: string;
} {
  const tmp = testTmpDir(dir);
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return {
    DIPO_TEST: "1",
    DIPO_HOME: testStateDir(dir),
    DIPO_RUNTIME_DIR: testRuntimeDir(dir),
    TMPDIR: tmp,
    DIPO_TMP: dir,
  };
}

export interface RuntimeChoice {
  readonly path: string;
  readonly source: string;
}

/** The `runtime directory chosen` entries of a daemon log (JSON lines; other lines are skipped). */
export function runtimeChoices(log: string): RuntimeChoice[] {
  const choices: RuntimeChoice[] = [];
  for (const line of log.split("\n")) {
    if (!line.includes(RUNTIME_CHOSEN_MESSAGE)) continue;
    try {
      const entry = JSON.parse(line) as { msg?: unknown; path?: unknown; source?: unknown };
      if (entry.msg !== RUNTIME_CHOSEN_MESSAGE) continue;
      choices.push({ path: String(entry.path), source: String(entry.source) });
    } catch {
      // Not a log entry.
    }
  }
  return choices;
}

/**
 * Throws when a test daemon in `dir` chose a runtime directory other than its `DIPO_RUNTIME_DIR`,
 * reading `log` or else `<dir>/state/logs/daemon.log`. Returns how many choices it checked: zero
 * for a daemon that stopped before choosing.
 */
export function assertTestRuntimeDir(dir: string, log?: string): number {
  const path = join(testStateDir(dir), "logs", "daemon.log");
  const text = log ?? (existsSync(path) ? readFileSync(path, "utf8") : "");
  const choices = runtimeChoices(text);
  const expected = testRuntimeDir(dir);
  for (const choice of choices) {
    if (choice.source !== TEST_RUNTIME_SOURCE || choice.path !== expected) {
      throw new Error(
        `a test daemon chose runtime directory ${choice.path} (source ${choice.source}), not its ${TEST_RUNTIME_SOURCE} ${expected}; it may have removed a real daemon's socket there. Set DIPO_TMP to a short directory (at most ${MAX_TEMP_ROOT_BYTES} bytes) and start test daemons with isolatedDaemonEnv.`,
      );
    }
  }
  return choices.length;
}
