// Tests run with a cleaned environment: no ANTHROPIC_*, CLAUDE_* or GH_* variables
// (0017 section 3), so no test can reach Claude or GitHub with the maintainer's credentials.

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
