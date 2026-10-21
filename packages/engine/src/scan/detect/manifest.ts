// Pure readers for the manifests the scan understands: package.json, the `packages` key of
// pnpm-workspace.yaml, .claude/backlog-workflow.json, and import specifiers in config files.

import type { PackageManagerName } from "./types";

export const ROOT_MANIFEST = "package.json";
export const PNPM_WORKSPACE = "pnpm-workspace.yaml";
export const WORKFLOW_FILE = ".claude/backlog-workflow.json";
export const RUNTIME_FILES = [".node-version", ".nvmrc"] as const;
/**
 * The Bun version file, read for the box's default toolchain (0021 section 5, DIPO-266). It is no
 * run profile input, so it stays out of the fingerprint.
 */
export const BUN_VERSION_FILE = ".bun-version";

/** Lockfiles in 0013 section 3 order, with the package manager each belongs to. */
export const LOCKFILES: readonly (readonly [string, PackageManagerName])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** Dev server and runtime config files (0013 section 5), matched on the file name. */
const CONFIG_FILE =
  /^(?:vite\.config|next\.config|react-router\.config|playwright\.config)\.[^/]+$|^wrangler\.[^/]+$/;

export const isConfigFile = (name: string) => CONFIG_FILE.test(name);
export const isViteConfig = (name: string) => /^vite\.config\.[^/]+$/.test(name);

export type Manifest = {
  readonly name: string | null;
  readonly scripts: Readonly<Record<string, string>>;
  readonly packageManager: string | null;
  readonly workspaces: readonly string[];
  readonly engines: Readonly<Record<string, string>>;
  /** The fields the fingerprint hashes, as written. */
  readonly fingerprintFields: Readonly<Record<string, unknown>>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** Parses a package.json text; returns null when it is not a JSON object. */
export function parseManifest(text: string): Manifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const workspaces = Array.isArray(parsed["workspaces"])
    ? strings(parsed["workspaces"])
    : isRecord(parsed["workspaces"])
      ? strings(parsed["workspaces"]["packages"])
      : [];
  return {
    name: typeof parsed["name"] === "string" ? parsed["name"] : null,
    scripts: stringRecord(parsed["scripts"]),
    packageManager: typeof parsed["packageManager"] === "string" ? parsed["packageManager"] : null,
    workspaces,
    engines: stringRecord(parsed["engines"]),
    fingerprintFields: {
      scripts: parsed["scripts"] ?? null,
      packageManager: parsed["packageManager"] ?? null,
      workspaces: parsed["workspaces"] ?? null,
      engines: parsed["engines"] ?? null,
    },
  };
}

/** `exports` of a package.json, for resolving a config module import into a workspace package. */
export function parseExports(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? (parsed["exports"] ?? null) : null;
  } catch {
    return null;
  }
}

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, "$2");

function stripComment(line: string): string {
  // A `#` starts a comment at the line start or after whitespace, outside quotes.
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * The `packages` list of a pnpm-workspace.yaml. Only that key is read: other keys, such as a
 * dependency `catalog`, are dependency changes (0013 section 5). Handles the block and flow
 * sequence forms pnpm documents.
 */
export function parsePnpmWorkspacePackages(text: string): string[] {
  const lines = text.split(/\r?\n/).map(stripComment);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start === -1) return [];
  const rest = (lines[start] ?? "").replace(/^packages\s*:/, "").trim();
  if (rest.startsWith("[")) {
    return rest
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((entry) => unquote(entry.trim()))
      .filter((entry) => entry !== "");
  }
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line) && !line.startsWith("-")) break;
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (item?.[1] !== undefined) out.push(unquote(item[1]));
  }
  return out;
}

export type Workflow = {
  readonly install: string | null;
  readonly verify: readonly string[];
  readonly includeGitignored: readonly string[];
};

/** The parts of .claude/backlog-workflow.json the scan reads as evidence (0013 section 3). */
export function parseWorkflow(text: string): Workflow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const worktree = isRecord(parsed["worktree"]) ? parsed["worktree"] : {};
  const install = worktree["install"];
  return {
    install: typeof install === "string" && install.trim() !== "" ? install.trim() : null,
    verify: strings(parsed["verify"])
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
    includeGitignored: strings(worktree["includeGitignored"]),
  };
}

/** Import and re-export specifiers of a JavaScript or TypeScript module. */
export function importSpecifiers(text: string): string[] {
  const out = new Set<string>();
  const pattern =
    /\b(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) out.add(specifier);
  }
  return [...out];
}

/** Converts a workspace glob (`apps/*`, `packages/**`, `e2e`) to a matcher for directories. */
export function workspaceMatcher(pattern: string): (dir: string) => boolean {
  const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  let source = "";
  for (let i = 0; i < clean.length; i++) {
    const char = clean.charAt(i);
    if (char === "*" && clean.charAt(i + 1) === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  const regex = new RegExp(`^${source}$`);
  return (dir) => regex.test(dir);
}

/** Expands workspace patterns (with `!` negations) over the directories that hold a package.json. */
export function expandWorkspaces(patterns: readonly string[], manifestDirs: readonly string[]) {
  const include = patterns.filter((p) => !p.startsWith("!")).map(workspaceMatcher);
  const exclude = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => workspaceMatcher(p.slice(1)));
  return manifestDirs
    .filter((dir) => dir !== "" && !dir.split("/").includes("node_modules"))
    .filter((dir) => include.some((m) => m(dir)) && !exclude.some((m) => m(dir)))
    .toSorted();
}

/** Joins a directory and a name into a repo-relative path; `""` is the root. */
export const joinPath = (dir: string, name: string) =>
  dir === "" || dir === "." ? name : `${dir}/${name}`;

/** The directory of a repo-relative path; `""` for a root file. */
export function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
