// The npm token check (DIPO-172): worker code may read every sandbox read path, so an npm auth
// token in a config file under one reaches it. npm's global config of a node install is
// `<prefix>/etc/npmrc`, and `npm config set --global` writes a token there; under nvm that file is
// below `~/.nvm/versions/node`, a toolchain read path on a machine that adds it in
// `.dipo/office.local.yaml`. Tokens belong in the user-level `~/.npmrc`, which the sandbox cannot
// read. The check reads only whether an auth key is present: it never logs, stores or returns a
// value, only the file and the name of the key.
//
// A refusal is a `PlanError`, not a failed launch check: the token is in this office's read
// paths, so it refuses this run and does not hold the adapter for other offices.

import { readdir, readFile } from "node:fs/promises";
import { posix } from "node:path";

import { expandHome, isAtOrUnder } from "../../sandbox/policy";
import { PlanError } from "../types";
import type { ClaudeLaunchContext } from "./plan";

/** The npm config keys that hold a credential, bare or scoped (`//registry/:_authToken`). */
export const NPM_AUTH_KEYS = ["_authToken", "_auth", "_password"] as const;
export type NpmAuthKey = (typeof NPM_AUTH_KEYS)[number];

/** One npm config file the worker sandbox can read that holds an auth key. */
export interface NpmTokenFinding {
  /** The absolute path of the file. */
  readonly file: string;
  /** The auth key's name without its scope, never its value. */
  readonly key: NpmAuthKey;
  /** The read path, as the office configuration spells it, that makes the file readable. */
  readonly readPath: string;
}

/** A read path as the office configuration spells it and as an absolute path. */
interface ReadPath {
  readonly entry: string;
  readonly path: string;
}

/**
 * Pure: the first auth key an npmrc text sets, or null. Only each line's key is looked at;
 * the value is never kept. Comments (`;`, `#`) and section headers are skipped.
 */
export function npmAuthKey(text: string): NpmAuthKey | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith(";") || line.startsWith("#") || line.startsWith("[")) {
      continue;
    }
    const at = line.indexOf("=");
    const key = (at < 0 ? line : line.slice(0, at)).trim().replace(/^["']|["']$/g, "");
    const name = key.slice(key.lastIndexOf(":") + 1);
    const found = NPM_AUTH_KEYS.find((candidate) => candidate === name);
    if (found !== undefined) return found;
  }
  return null;
}

async function childDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => posix.join(dir, entry.name))
      .toSorted();
  } catch {
    return [];
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    // Absent, a directory, or unreadable to the daemon user, and so to the worker too.
    return null;
  }
}

// The node installs (npm prefixes) a read path holds: the path itself (a prefix such as
// /usr/local), its directories (a directory of installs such as ~/.nvm/versions/node), and the
// installs of an nvm root at or below it.
async function prefixesUnder(root: string): Promise<string[]> {
  const nested = await Promise.all([
    childDirs(root),
    childDirs(posix.join(root, "versions", "node")),
    childDirs(posix.join(root, ".nvm", "versions", "node")),
  ]);
  return [root, ...nested.flat()];
}

/**
 * The npm config files of `readPaths` that hold an auth key: `.npmrc` at the root of a read path,
 * and npm's global config (`<prefix>/etc/npmrc`) of every node install under one, the installs
 * whose `bin` is on `searchPath` included. `home` expands `~/`. Reads files; never throws.
 */
export async function findNpmTokens(input: {
  readonly home: string;
  readonly readPaths: readonly string[];
  /** The worker's PATH, `:`-separated. */
  readonly searchPath: string;
}): Promise<NpmTokenFinding[]> {
  const roots: ReadPath[] = input.readPaths
    .map((entry) => ({ entry, path: posix.normalize(expandHome(entry, input.home)) }))
    .filter((root) => root.path.startsWith("/"));
  const pathPrefixes = input.searchPath
    .split(":")
    .filter((entry) => entry.startsWith("/") && posix.basename(entry) === "bin")
    .map((entry) => posix.dirname(posix.normalize(entry)));

  const candidates = new Map<string, ReadPath>();
  const add = (file: string, root: ReadPath) => {
    if (!candidates.has(file)) candidates.set(file, root);
  };
  for (const root of roots) {
    add(posix.join(root.path, ".npmrc"), root);
    for (const prefix of await prefixesUnder(root.path)) add(posix.join(prefix, "etc/npmrc"), root);
    for (const prefix of pathPrefixes) {
      if (isAtOrUnder(prefix, root.path)) add(posix.join(prefix, "etc/npmrc"), root);
    }
  }

  const findings: NpmTokenFinding[] = [];
  for (const [file, root] of candidates) {
    const text = await readOptional(file);
    const key = text === null ? null : npmAuthKey(text);
    if (key !== null) findings.push({ file, key, readPath: root.entry });
  }
  return findings;
}

/** The refusal text for the findings: each file and key name, and where tokens belong. */
export function npmTokenRefusal(findings: readonly NpmTokenFinding[]): string {
  const files = findings
    .map(
      (finding) =>
        `${finding.file} holds an npm auth key (${finding.key}) and the worker sandbox can read it through the read path ${finding.readPath}`,
    )
    .join("; ");
  return `${files}. Keep npm tokens in ~/.npmrc, which the worker sandbox cannot read: remove the auth line from ${findings.length === 1 ? "that file" : "those files"} and log in to the registry again with \`npm login\``;
}

/**
 * Refuses the launch with a `PlanError` when an npm config file the worker sandbox can read
 * (`sandbox.toolchainReadPaths` and `sandbox.allowRead`) holds an auth key.
 */
export async function checkNpmTokens(ctx: ClaudeLaunchContext): Promise<void> {
  const findings = await findNpmTokens({
    home: ctx.home,
    readPaths: [...ctx.sandbox.toolchainReadPaths, ...ctx.sandbox.allowRead],
    searchPath: [ctx.env["PATH"] ?? "", ctx.safeChain?.path ?? ""].join(":"),
  });
  if (findings.length > 0) throw new PlanError(npmTokenRefusal(findings));
}
