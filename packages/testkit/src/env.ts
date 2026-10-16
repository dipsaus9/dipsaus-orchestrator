// Tests run with a cleaned environment: no ANTHROPIC_*, CLAUDE_* or GH_* variables
// (0017 section 3), so no test can reach Claude or GitHub with the maintainer's credentials. A
// daemon a test starts as a process also gets its state, runtime and temp directories under the
// test's temp directory (DIPO-109).

import { isolatedDaemonEnv } from "./runtime";

export const REMOVED_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "GH_"] as const;

export function isRemovedEnvName(name: string): boolean {
  return REMOVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** A copy of `source` without the removed variables, ready to pass to a child process. */
export function cleanEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !isRemovedEnvName(name)) env[name] = value;
  }
  return env;
}

/**
 * The environment of a `dipo daemon` process a test starts in `dir`: `cleanEnv(source)` without
 * `BUN_OPTIONS` and `DIPO_LOG`, with `isolatedDaemonEnv(dir)` on top. Every runtime directory
 * candidate is then under `dir` except the daemon's last one, `/tmp/dipo-<uid>`, which
 * `withDaemonTempDir` and `assertTestRuntimeDir` fail on.
 */
export function daemonTestEnv(
  dir: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env = cleanEnv(source);
  delete env["BUN_OPTIONS"];
  delete env["DIPO_LOG"];
  return { ...env, ...isolatedDaemonEnv(dir) };
}

/**
 * Runs `fn` with the removed variables deleted from `process.env`, and puts them back in a
 * `finally`, so code under test that reads `process.env` directly sees the cleaned environment.
 */
export async function withCleanEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved: [string, string][] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && isRemovedEnvName(name)) {
      saved.push([name, value]);
      delete process.env[name];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) process.env[name] = value;
  }
}
