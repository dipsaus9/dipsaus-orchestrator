// The environment of a sandboxed step (0008 section 2: "an allowlisted environment"). Only the
// names below pass from the daemon's environment; tokens such as `GH_TOKEN`, `NPM_TOKEN` and
// `ANTHROPIC_API_KEY` never reach worker code. Runtime option variables (`BUN_OPTIONS`,
// `NODE_OPTIONS`, `BUN_CONFIG_*`) are dropped even when the engine passes them as extras: they
// would change how `dipo` itself starts. `TMPDIR` and `DIPO_TMP` point at the step's temp root.

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

/** True for a variable that changes how Bun or Node start; never set in a step. */
export function isRuntimeOptionName(name: string): boolean {
  return name === "BUN_OPTIONS" || name === "NODE_OPTIONS" || name.startsWith("BUN_CONFIG_");
}

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
  for (const [name, value] of Object.entries(extra)) {
    if (!isRuntimeOptionName(name)) env[name] = value;
  }
  return { ...env, TMPDIR: tempRoot, DIPO_TMP: tempRoot };
}
