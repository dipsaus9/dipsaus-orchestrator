// Hardened engine git calls (0008 section 2, "Engine git calls"). The engine runs git outside any
// sandbox, with the maintainer's credentials, so no call may run a command a repository chose:
// `GIT_CONFIG_NOSYSTEM=1`, `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, no pager, no
// terminal prompt, C locale (stable messages for the lock check), and `GIT_DIR` and
// `GIT_COMMON_DIR` from paths the engine recorded, never discovered from a worktree. Location
// variables inherited from the daemon's environment are dropped first.

/** Where one git call runs. Paths are absolute and recorded by the engine. */
export type GitLocation =
  /** No repository: `git --version`. */
  | { readonly kind: "none"; readonly cwd: string }
  /**
   * The repository without any work tree (`git --bare`, cwd and `GIT_DIR` the common dir): fetch,
   * refs, `worktree add`. Such a call cannot touch the maintainer's main checkout.
   */
  | { readonly kind: "repository"; readonly commonDir: string }
  /** A linked worktree the engine owns, with its administrative directory under the common dir. */
  | {
      readonly kind: "worktree";
      readonly commonDir: string;
      readonly gitDir: string;
      readonly workTree: string;
    };

/** Config every engine git call sets on the command line, where it beats every config file. */
export const HARDENED_CONFIG: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.quotePath", "off"],
];

/**
 * Inherited variables that would move git to another repository, index or object store, or run
 * a command of their own; the engine sets the ones it needs itself.
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
];

/** The argument list of a hardened call: config overrides, then `--bare` for repository calls. */
export function hardenedArgs(location: GitLocation, args: readonly string[]): string[] {
  const config = HARDENED_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  return ["--no-pager", ...config, ...(location.kind === "repository" ? ["--bare"] : []), ...args];
}

/** The complete environment of a hardened call, built from `base` (the daemon's environment). */
export function hardenedEnv(
  base: Readonly<Record<string, string | undefined>>,
  location: GitLocation,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !DROPPED_GIT_ENV.includes(name)) env[name] = value;
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "false",
    LC_ALL: "C",
    LANGUAGE: "C",
  });
  if (location.kind === "repository") {
    env["GIT_DIR"] = location.commonDir;
    env["GIT_COMMON_DIR"] = location.commonDir;
  } else if (location.kind === "worktree") {
    env["GIT_DIR"] = location.gitDir;
    env["GIT_COMMON_DIR"] = location.commonDir;
    env["GIT_WORK_TREE"] = location.workTree;
  }
  return env;
}

/** The working directory of a hardened call. */
export function hardenedCwd(location: GitLocation): string {
  switch (location.kind) {
    case "none":
      return location.cwd;
    case "repository":
      return location.commonDir;
    case "worktree":
      return location.workTree;
  }
}
