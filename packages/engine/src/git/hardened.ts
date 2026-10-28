// Hardened engine git calls (0008 section 2, "Engine git calls"; 0010). The engine runs git outside
// any sandbox, with the maintainer's credentials, so no call may run a command a repository chose.
// What every call sets and drops is the one definition in the contract (`git-hardening.ts`), which
// the CLI's repository lookup shares; this file adds where a call runs: `GIT_DIR` and
// `GIT_COMMON_DIR` from paths the engine recorded, never discovered from a worktree.

import {
  DROPPED_GIT_ENV,
  DROPPED_GIT_ENV_PREFIXES,
  HARDENED_GIT_CONFIG,
  hardenedGitEnv,
  hardenedGitOptions,
  isDroppedGitEnv,
  KEPT_AUTH_ENV,
} from "@dipsaus-orchestrator/contract";

export {
  DROPPED_GIT_ENV,
  DROPPED_GIT_ENV_PREFIXES,
  HARDENED_GIT_CONFIG as HARDENED_CONFIG,
  isDroppedGitEnv,
  KEPT_AUTH_ENV,
};

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

/** Extra config for a fetch: the `ext::` transport, which runs a command, is never allowed. */
export const FETCH_CONFIG: readonly (readonly [string, string])[] = [
  ["protocol.ext.allow", "never"],
];

/**
 * Extra config and environment for checkouts of `_base`: no Git LFS smudge, so no filter reaches
 * the network or runs a long-lived process while the engine reads the base.
 */
export const BASE_CHECKOUT_CONFIG: readonly (readonly [string, string])[] = [
  ["filter.lfs.process", ""],
  ["filter.lfs.smudge", ""],
];
export const BASE_CHECKOUT_ENV: Readonly<Record<string, string>> = { GIT_LFS_SKIP_SMUDGE: "1" };

/** `worktree add` writes absolute `gitdir` links, which the engine records and compares. */
export const WORKTREE_ADD_CONFIG: readonly (readonly [string, string])[] = [
  ["worktree.useRelativePaths", "false"],
];

/** The argument list of a hardened call: config overrides, then `--bare` for repository calls. */
export function hardenedArgs(
  location: GitLocation,
  args: readonly string[],
  extraConfig: readonly (readonly [string, string])[] = [],
): string[] {
  return [
    ...hardenedGitOptions(extraConfig),
    ...(location.kind === "repository" ? ["--bare"] : []),
    ...args,
  ];
}

/** The complete environment of a hardened call, built from `base` (the daemon's environment). */
export function hardenedEnv(
  base: Readonly<Record<string, string | undefined>>,
  location: GitLocation,
  extraEnv: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env = hardenedGitEnv(base, extraEnv);
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
