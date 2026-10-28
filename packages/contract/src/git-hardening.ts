// How every git call of dipo is hardened (0010): one definition that the engine's git module and
// the CLI's read-only repository lookup share, so the two cannot drift. No call may run a command a
// repository chose: no system config, hooks off, no fsmonitor, no pager, no terminal prompt, a C
// locale, and none of the inherited variables that would move git to another repository or add
// config of their own. The maintainer's own ssh and askpass settings stay (`KEPT_AUTH_ENV`).

/** Config every git call sets on the command line, where it beats every config file. */
export const HARDENED_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.quotePath", "off"],
];

/**
 * Inherited variables that would move git to another repository, index or object store, or run
 * a command of their own; a caller sets the ones it needs itself.
 */
export const DROPPED_GIT_ENV: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_PAGER",
  "PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_ATTR_SOURCE",
];

/** Inherited variables dropped by prefix: the numbered `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`. */
export const DROPPED_GIT_ENV_PREFIXES: readonly string[] = ["GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];

/**
 * Kept from the inherited environment on purpose: the maintainer's own transport and credential
 * prompts, which fetch and push need to authenticate as the maintainer. They come from the
 * maintainer's session, never from a repository.
 */
export const KEPT_AUTH_ENV: readonly string[] = [
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
];

/** Set on every git call, over anything inherited. */
export const HARDENED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_EDITOR: "false",
  LC_ALL: "C",
  LANGUAGE: "C",
};

/** True when an inherited variable is dropped from a hardened call. */
export function isDroppedGitEnv(name: string): boolean {
  return (
    DROPPED_GIT_ENV.includes(name) ||
    DROPPED_GIT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** The options before the git verb: no pager, then every hardened and extra `-c key=value`. */
export function hardenedGitOptions(
  extraConfig: readonly (readonly [string, string])[] = [],
): string[] {
  const config = [...HARDENED_GIT_CONFIG, ...extraConfig].flatMap(([key, value]) => [
    "-c",
    `${key}=${value}`,
  ]);
  return ["--no-pager", ...config];
}

/**
 * The environment of a hardened call built from `base` (the inherited one): the dropped variables
 * removed, `HARDENED_GIT_ENV` set, then `extraEnv`.
 */
export function hardenedGitEnv(
  base: Readonly<Record<string, string | undefined>>,
  extraEnv: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !isDroppedGitEnv(name)) env[name] = value;
  }
  return { ...env, ...HARDENED_GIT_ENV, ...extraEnv };
}
