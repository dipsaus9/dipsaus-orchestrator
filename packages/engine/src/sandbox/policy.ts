// The run policy of an engine step on worker-written code, translated into a settings file for the
// bundled sandbox runtime `srt` (0008 section 2, "Engine steps on worker-written code"). Pure: the
// caller passes every path, so the same run gives the same file (golden files in the tests).
//
// The policy: writes to the worktree and the step temp root, `denyWrite` on `<main>/.git` and
// `<worktree>/.git`, `denyRead` on the secret paths, Unix sockets under the temp root, network
// closed for verify. Install adds `allowWrite` on the office's toolchain paths and network to its
// registry hosts only. On Linux `srt` takes literal write paths: a trailing `/**` is dropped and
// other globs are skipped with a warning.

import type { DipoPlatform } from "../platform/paths";

/** Which policy a step runs under. Install reaches the registries; every other step has no network. */
export type StepPolicyKind = "install" | "verify";

/** The facts of one step that its policy is built from. Every path is absolute. */
export interface SandboxRun {
  readonly platform: DipoPlatform;
  readonly kind: StepPolicyKind;
  /** The home directory the secret paths and `~/` toolchain paths are resolved against. */
  readonly home: string;
  /** The main checkout, whose shared `.git` the step may not write. */
  readonly mainCheckout: string;
  /** The worktree the step runs in. */
  readonly worktree: string;
  /** The step's fresh temp root, `/tmp/dipo-s-<id>`. */
  readonly tempRoot: string;
  /** `sandbox.toolchainPaths` of the office: absolute or starting with `~/`. */
  readonly toolchainPaths: readonly string[];
  /** `sandbox.registryHosts` of the office. */
  readonly registryHosts: readonly string[];
}

/** The part of the `srt` settings schema (0.0.79) that dipo writes. */
export interface SrtSettings {
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    readonly strictAllowlist: boolean;
    readonly allowUnixSockets?: readonly string[];
    readonly allowAllUnixSockets?: boolean;
  };
  readonly filesystem: {
    readonly denyRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
  };
}

export interface TranslatedPolicy {
  readonly settings: SrtSettings;
  /** One line per path that could not be translated (a glob on Linux). */
  readonly warnings: readonly string[];
}

/** The secret paths of 0008 section 2, relative to the home directory. */
export const SECRET_HOME_PATHS = [".ssh", ".aws", ".config/gh", ".gnupg", ".netrc"] as const;

/** Expands a leading `~` or `~/` against `home`; any other path is returned unchanged. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return joinPath(home, path.slice(2));
  return path;
}

function joinPath(base: string, rest: string): string {
  if (rest === "") return base;
  return `${base.endsWith("/") ? base.slice(0, -1) : base}/${rest}`;
}

const GLOB = /[*?[\]{}]/;

/**
 * Linux path rule for `allowWrite` and `denyWrite`: bubblewrap binds literal paths, so a trailing
 * `/**` is dropped and any other glob is skipped. Returns the literal path or null.
 */
export function linuxLiteralPath(path: string): string | null {
  const stripped = path.endsWith("/**") ? path.slice(0, -3) : path;
  if (stripped === "" || GLOB.test(stripped)) return null;
  return stripped;
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/** Builds the `srt` settings for one step. */
export function translatePolicy(run: SandboxRun): TranslatedPolicy {
  const warnings: string[] = [];
  const literal = (list: string, paths: readonly string[]): string[] => {
    if (run.platform !== "linux") return unique(paths);
    const kept: string[] = [];
    for (const path of paths) {
      const result = linuxLiteralPath(path);
      if (result === null) {
        warnings.push(`${list}: skipped ${path} (a glob; Linux takes literal paths only)`);
      } else {
        kept.push(result);
      }
    }
    return unique(kept);
  };

  const toolchain =
    run.kind === "install" ? run.toolchainPaths.map((path) => expandHome(path, run.home)) : [];
  const allowWrite = literal("allowWrite", [run.worktree, run.tempRoot, ...toolchain]);
  const denyWrite = literal("denyWrite", [
    joinPath(run.mainCheckout, ".git"),
    joinPath(run.worktree, ".git"),
  ]);
  const denyRead = unique(SECRET_HOME_PATHS.map((path) => joinPath(run.home, path)));

  // macOS Seatbelt filters Unix sockets by path. Linux seccomp cannot, so there the only way to let
  // a step create a socket under its temp root is to allow Unix sockets as a whole.
  const sockets =
    run.platform === "darwin"
      ? { allowUnixSockets: [run.tempRoot] }
      : { allowAllUnixSockets: true as const };

  return {
    settings: {
      network: {
        allowedDomains: run.kind === "install" ? unique(run.registryHosts) : [],
        deniedDomains: [],
        strictAllowlist: true,
        ...sockets,
      },
      filesystem: { denyRead, allowWrite, denyWrite },
    },
    warnings,
  };
}

/** The deny-all policy of the smoke check: no network, no writes, no Unix sockets. */
export const DENY_ALL_SETTINGS: SrtSettings = {
  network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
};
