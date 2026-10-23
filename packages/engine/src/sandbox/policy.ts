// The `srt` settings dipo writes for `dipo daemon sandbox-exec` (0008 section 2), and the trust
// checks over them: the paths a settings file makes writable, srt's own default write paths, and
// why a run may not start (a pinned host program, the dipo binary or a PATH directory under a
// writable path). Only the Safe-Chain checking proxy runs in it now (DIPO-84); the per-step
// policies of the engine's install and verify on worker-written code went with the Mac worker path
// (DIPO-240), since a developer's install and verify run in its box.

/** Absolute paths of the host programs srt runs; null when not found. */
export interface SandboxTools {
  readonly rg: string | null;
  readonly bwrap: string | null;
  readonly socat: string | null;
}

/** The part of the `srt` settings schema (0.0.79) that dipo writes. */
export interface SrtSettings {
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    readonly strictAllowlist: boolean;
    readonly allowUnixSockets?: readonly string[];
    readonly allowAllUnixSockets?: boolean;
    /** Only the Safe-Chain proxy's own sandbox (DIPO-84); never a step on worker code. */
    readonly allowLocalBinding?: boolean;
  };
  readonly filesystem: {
    readonly denyRead: readonly string[];
    /** Paths re-allowed inside `denyRead` (the Safe-Chain proxy's sandbox, DIPO-84). */
    readonly allowRead?: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
  };
  readonly ripgrep?: { readonly command: string };
  readonly bwrapPath?: string;
  readonly socatPath?: string;
}

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
