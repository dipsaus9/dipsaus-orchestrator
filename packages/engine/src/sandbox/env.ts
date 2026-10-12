// The environment of a sandboxed step (0008 section 2: "an allowlisted environment"). Only the
// names below pass from the daemon's environment; tokens such as `GH_TOKEN`, `NPM_TOKEN` and
// `ANTHROPIC_API_KEY`, and Bun or Node options such as `BUN_OPTIONS`, never reach worker code.
// `TMPDIR` and `DIPO_TMP` point at the step's temp root.

/** Names passed through from the daemon's environment when set. */
export const STEP_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TZ",
] as const;

/**
 * Builds the step environment: the allowlisted names from `source`, then `extra` (set by the
 * engine, never by worker code), then `TMPDIR` and `DIPO_TMP`, which nothing overrides.
 */
export function stepEnv(
  source: Readonly<Record<string, string | undefined>>,
  tempRoot: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of STEP_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra, TMPDIR: tempRoot, DIPO_TMP: tempRoot };
}
