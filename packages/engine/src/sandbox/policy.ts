// The run policy of an engine step on worker-written code, translated into a settings file for the
// bundled sandbox runtime `srt` (0008 section 2, "Engine steps on worker-written code"). Pure: the
// caller passes every path, so the same run gives the same file (golden files in the tests).
//
// The policy: writes to the worktree and the step temp root, `denyWrite` on `<main>/.git` and
// `<worktree>/.git`, `denyRead` on the secret paths, Unix sockets under the temp root, network
// closed for verify. Install adds `allowWrite` on the office's install caches and network to its
// registry hosts only. The office's toolchain read paths need no entry: srt has no home-wide read
// block, so `bun` and `npm` stay readable for every step (0008 amendment of 2026-10-12). On Linux `srt` takes literal write paths: a trailing `/**` is dropped and
// other globs are skipped with a warning.
//
// Beyond 0008's list (DIPO-37 review): more secret files, dipo's own state and runtime
// directories, and the well-known agent and daemon sockets are read-denied too, because on Linux a
// step may open any Unix socket it can see (srt's seccomp filter cannot filter by path).
//
// The host programs srt runs outside the sandbox (`bwrap`, `socat`, `rg`) are pinned to absolute
// paths, and `trustViolations` refuses a step when one of them, the dipo binary or a PATH
// directory lies under a path the policy makes writable.

import type { DipoPlatform } from "../platform/paths";

/** Which policy a step runs under. Install reaches the registries; every other step has no network. */
export type StepPolicyKind = "install" | "verify";

/** Absolute paths of the host programs srt runs; null when not found. */
export interface SandboxTools {
  readonly rg: string | null;
  readonly bwrap: string | null;
  readonly socat: string | null;
}

/** The facts of one step that its policy is built from. Every path is absolute. */
export interface SandboxRun {
  readonly platform: DipoPlatform;
  readonly kind: StepPolicyKind;
  /** The home directory the secret paths and `~/` install caches are resolved against. */
  readonly home: string;
  /** The user id, for `/run/user/<uid>`. */
  readonly uid: number;
  /** The main checkout, whose shared `.git` the step may not write. */
  readonly mainCheckout: string;
  /** The worktree the step runs in. */
  readonly worktree: string;
  /** The step's fresh temp root, `/tmp/dipo-s-<id>`. */
  readonly tempRoot: string;
  /** dipo's state and runtime directories; the step may not read them or reach their sockets. */
  readonly dipoDirs: readonly string[];
  /** `SSH_AUTH_SOCK` of the daemon, when set; its directory is read-denied. */
  readonly sshAuthSock?: string | undefined;
  /**
   * `sandbox.installCachePaths` of the office: absolute or starting with `~/`. Install writes them;
   * one that holds a PATH directory or the dipo or bun binary refuses the step (`trustViolations`).
   */
  readonly installCachePaths: readonly string[];
  /** `sandbox.registryHosts` of the office. */
  readonly registryHosts: readonly string[];
  /** Pinned host programs; when given they go into the settings file. */
  readonly tools?: SandboxTools | undefined;
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
  readonly ripgrep?: { readonly command: string };
  readonly bwrapPath?: string;
  readonly socatPath?: string;
}

export interface TranslatedPolicy {
  readonly settings: SrtSettings;
  /** One line per path that could not be translated (a glob on Linux). */
  readonly warnings: readonly string[];
}

/** The secret paths of 0008 section 2, relative to the home directory. */
export const SECRET_HOME_PATHS = [".ssh", ".aws", ".config/gh", ".gnupg", ".netrc"] as const;

/** Secret paths beyond 0008's list (DIPO-37 review; an ADR amendment is proposed). */
export const EXTRA_SECRET_HOME_PATHS = [
  ".npmrc",
  ".git-credentials",
  ".claude",
  ".docker",
  ".kube",
] as const;

/** Sockets of other daemons a step must not reach (beyond 0008, DIPO-37 review). */
export const DENIED_SOCKET_PATHS = ["/var/run/docker.sock", "/run/docker.sock", "/tmp/ssh-*"];

/**
 * Paths srt 0.0.79 always makes writable (`getDefaultWritePaths`), relative to `/` or to the
 * home directory. A pinned program or PATH directory under one of them is refused.
 */
export const SRT_DEFAULT_WRITE_PATHS = ["/tmp/claude", "/private/tmp/claude"] as const;
export const SRT_DEFAULT_HOME_WRITE_PATHS = [".claude/debug", ".npm/_logs"] as const;

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

function parentDir(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
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

/** The literal directory a path or glob can write under: everything before its first glob. */
export function globRoot(path: string): string {
  const at = path.search(GLOB);
  if (at < 0) return path;
  const head = path.slice(0, at);
  return head.endsWith("/") ? head.slice(0, -1) || "/" : parentDir(head);
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

  const caches =
    run.kind === "install" ? run.installCachePaths.map((path) => expandHome(path, run.home)) : [];
  const allowWrite = literal("allowWrite", [run.worktree, run.tempRoot, ...caches]);
  const denyWrite = literal("denyWrite", [
    joinPath(run.mainCheckout, ".git"),
    joinPath(run.worktree, ".git"),
  ]);
  const workRoots = [run.worktree, run.tempRoot, run.mainCheckout];
  const covers = (dir: string) => workRoots.some((root) => isAtOrUnder(root, dir));
  const agentDir = run.sshAuthSock ? parentDir(run.sshAuthSock) : null;
  const agent =
    run.sshAuthSock === undefined || agentDir === null
      ? []
      : [covers(agentDir) ? run.sshAuthSock : agentDir];
  // A deny over the worktree or the temp root would hide them from the step; it is kept here and
  // `sandbox-exec` refuses the run (`coveringDenies`), so the step fails closed.
  const denyRead = unique([
    ...[...SECRET_HOME_PATHS, ...EXTRA_SECRET_HOME_PATHS].map((rel) => joinPath(run.home, rel)),
    ...run.dipoDirs,
    `/run/user/${run.uid}`,
    ...DENIED_SOCKET_PATHS,
    ...agent,
  ]);

  // macOS Seatbelt filters Unix sockets by path. Linux seccomp cannot, so there the only way to let
  // a step create a socket under its temp root is to allow Unix sockets as a whole; the read denies
  // above hide the sockets it must not reach.
  const sockets =
    run.platform === "darwin"
      ? { allowUnixSockets: [run.tempRoot] }
      : { allowAllUnixSockets: true as const };

  const tools = run.tools;
  const pinned = {
    ...(tools?.rg ? { ripgrep: { command: tools.rg } } : {}),
    ...(run.platform === "linux" && tools?.bwrap ? { bwrapPath: tools.bwrap } : {}),
    ...(run.platform === "linux" && tools?.socat ? { socatPath: tools.socat } : {}),
  };

  return {
    settings: {
      network: {
        allowedDomains: run.kind === "install" ? unique(run.registryHosts) : [],
        deniedDomains: [],
        strictAllowlist: true,
        ...sockets,
      },
      filesystem: { denyRead, allowWrite, denyWrite },
      ...pinned,
    },
    warnings,
  };
}

/** A path the sandboxed command can write, with where the permission comes from. */
export interface WritableRoot {
  readonly path: string;
  readonly source: string;
}

/** Every root a settings file makes writable: its `allowWrite` entries plus srt's defaults. */
export function writableRoots(settings: SrtSettings, homes: readonly string[]): WritableRoot[] {
  const roots: WritableRoot[] = settings.filesystem.allowWrite.map((path) => ({
    path: globRoot(path),
    source: `allowWrite ${path}`,
  }));
  for (const path of SRT_DEFAULT_WRITE_PATHS)
    roots.push({ path, source: "srt default write path" });
  for (const home of unique(homes)) {
    for (const rel of SRT_DEFAULT_HOME_WRITE_PATHS) {
      roots.push({ path: joinPath(home, rel), source: "srt default write path" });
    }
  }
  return roots;
}

/** A path that must not be writable by the step, in every spelling (as given, symlinks resolved). */
export interface TrustedCandidate {
  readonly label: string;
  readonly spellings: readonly string[];
}

/** True when `path` is `root` or lies below it. */
export function isAtOrUnder(path: string, root: string): boolean {
  if (root === "/") return path.startsWith("/");
  const clean = root.endsWith("/") ? root.slice(0, -1) : root;
  return path === clean || path.startsWith(`${clean}/`);
}

/**
 * Why a step may not run: a relative PATH entry, or a trusted program, binary or PATH directory
 * at or under a writable root. Writable roots and candidates come in every spelling the caller
 * knows (with and without symlinks resolved). Empty when the step may run.
 */
export function trustViolations(input: {
  readonly writable: readonly { readonly spellings: readonly string[]; readonly source: string }[];
  readonly candidates: readonly TrustedCandidate[];
  readonly pathEntries: readonly string[];
}): string[] {
  const reasons: string[] = [];
  for (const entry of input.pathEntries) {
    if (!entry.startsWith("/")) {
      reasons.push(`PATH holds a relative entry ${JSON.stringify(entry)}`);
    }
  }
  for (const candidate of input.candidates) {
    const hit = input.writable.find((root) =>
      root.spellings.some((r) => candidate.spellings.some((c) => isAtOrUnder(c, r))),
    );
    if (hit !== undefined) {
      reasons.push(
        `${candidate.label} ${candidate.spellings[0] ?? ""} is writable by the step (${hit.source})`,
      );
    }
  }
  return reasons;
}

/** The deny-all policy of the smoke check: no network, no writes, no Unix sockets. */
export const DENY_ALL_SETTINGS: SrtSettings = {
  network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
};

/** True when a path or glob of a deny list matches `path` (`*` and `?` stay within one segment). */
export function denyMatches(entry: string, path: string): boolean {
  if (!GLOB.test(entry)) return isAtOrUnder(path, entry);
  const pattern = entry
    .replace(/\/\*\*$/, "")
    .split("")
    .map((ch) =>
      ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : ch.replace(/[.+^$()|\\{}[\]]/g, "\\$&"),
    )
    .join("");
  const regex = new RegExp(`^${pattern}$`);
  // The path itself or any of its ancestors.
  for (let at = path; at !== "/" && at !== ""; at = parentDir(at)) {
    if (regex.test(at)) return true;
  }
  return false;
}

/**
 * Read denies that would hide a root the step must use (its working directory, temp root or a
 * write path), in every spelling given. Each one refuses the step: srt would mount over it.
 */
export function coveringDenies(
  denyRead: readonly string[],
  roots: readonly { readonly label: string; readonly spellings: readonly string[] }[],
): string[] {
  const reasons: string[] = [];
  for (const entry of denyRead) {
    for (const root of roots) {
      if (root.spellings.some((spelling) => denyMatches(entry, spelling))) {
        reasons.push(`denyRead ${entry} covers the ${root.label} ${root.spellings[0] ?? ""}`);
      }
    }
  }
  return reasons;
}
