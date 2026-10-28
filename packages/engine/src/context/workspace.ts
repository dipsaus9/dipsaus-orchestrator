// A `Workspace` over a checkout the engine owns (`gitWorkspace`, the `_base` checkout): file lists
// and `HEAD` through the office's git queue with hardened calls (DIPO-31), file bytes from the work
// tree. Or over a commit (`commitWorkspace`, a story's start commit or branch tip): everything read
// from git objects in the repository, since a story has no worktree (0010). Reads only. A read is
// refused, with a reason, unless the file is one regular file inside the work tree: a path that
// leaves the work tree, a symbolic link (as the file or on the way to it), a hard link (which may
// share its bytes with a file outside, or with a secret inside) and a secret path are never read.
// The file is opened without following a link and checked on the open descriptor, so a swap
// between the checks and the read cannot point the read at another file.

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import type { GitLocation } from "../git/hardened";
import type { OfficeGit } from "../git/office";
import { isSecretPath } from "./secrets";
import type { FileRefusal, Workspace } from "./types";

type WorktreeLocation = Extract<GitLocation, { kind: "worktree" }>;

const splitZ = (text: string) => text.split("\0").filter((entry) => entry !== "");

const refuse = (reason: string): FileRefusal => ({ refused: reason });

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface GitWorkspaceOptions {
  readonly git: OfficeGit;
  readonly location: WorktreeLocation;
}

/** True when `path` lies strictly under `root` (both resolved). */
function under(root: string, path: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Test seams: `beforeOpen` runs between the checks and the open, to stage a swap. */
export interface ReadHooks {
  readonly beforeOpen?: () => Promise<void>;
}

/** Reads `path` under `root`; see the file header for what is refused. */
export async function readInside(
  root: string,
  path: string,
  hooks: ReadHooks = {},
): Promise<Uint8Array | FileRefusal | undefined> {
  const clean = normalize(path);
  if (isAbsolute(clean) || clean === ".." || clean.startsWith(`..${sep}`)) {
    return refuse("path leaves the work tree");
  }
  if (isSecretPath(clean)) return refuse("secret path");
  const full = join(root, clean);
  let info;
  try {
    info = await lstat(full);
  } catch {
    return undefined;
  }
  if (info.isDirectory()) return undefined;
  if (info.isSymbolicLink()) return refuse("symbolic link");
  if (!info.isFile()) return refuse("not a regular file");
  let realRoot: string;
  let realFull: string;
  try {
    [realRoot, realFull] = await Promise.all([realpath(root), realpath(full)]);
  } catch {
    return undefined;
  }
  // lstat checks only the last segment: a directory on the way may be a link (or swapped for
  // one), so the resolved path must still lie under the resolved work tree, and not be a secret.
  if (!under(realRoot, realFull)) return refuse("resolves outside the work tree");
  if (isSecretPath(relative(realRoot, realFull))) return refuse("resolves to a secret path");
  let expected;
  let handle;
  try {
    expected = await lstat(realFull, { bigint: true });
    await hooks.beforeOpen?.();
    handle = await open(realFull, OPEN_FLAGS);
  } catch (error) {
    if ((error as { code?: string }).code === "ELOOP") return refuse("symbolic link");
    return undefined;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return refuse("not a regular file");
    if (opened.nlink !== 1n) return refuse("hard link");
    if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
      return refuse("changed while being read");
    }
    return new Uint8Array(await handle.readFile());
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

export function gitWorkspace(options: GitWorkspaceOptions): Workspace {
  const { git, location } = options;
  const root = location.workTree;
  const run = (args: readonly string[]) => git.run((session) => session.ok(location, args));
  return {
    root,
    async headSha() {
      return (await run(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    },
    async trackedFiles() {
      return [...new Set(splitZ(await run(["ls-files", "-z"])))].toSorted();
    },
    async files() {
      const out = await run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
      return [...new Set(splitZ(out))].toSorted();
    },
    readFile: (path) => readInside(root, path),
    filesByLastCommit: (sha, dir) => filesByLastCommitWith(run, sha, dir),
  };
}

/**
 * The files under `dir` ordered by the commit reachable from `sha` that last changed them, newest
 * first (`Workspace.filesByLastCommit`), through `run`.
 */
async function filesByLastCommitWith(
  run: (args: readonly string[]) => Promise<string>,
  sha: string,
  dir: string,
): Promise<readonly string[]> {
  // `-z` ends every name with NUL; each commit starts with a \x01 marker so its names can be
  // told apart from the next commit's. Newest first, so the first sighting is the last change.
  const out = await run([
    "log",
    sha,
    "--no-renames",
    "--name-only",
    "-z",
    "--format=%x01%H",
    "--",
    dir === "" ? "." : dir,
  ]);
  const seen = new Set<string>();
  const ordered: string[] = [];
  let commit: string[] = [];
  const flush = () => {
    for (const file of commit.toSorted()) {
      if (!seen.has(file)) {
        seen.add(file);
        ordered.push(file);
      }
    }
    commit = [];
  };
  for (const token of out.split("\0")) {
    let name = token;
    if (name.startsWith("\x01")) {
      flush();
      const newline = name.indexOf("\n");
      name = newline === -1 ? "" : name.slice(newline + 1);
    }
    name = name.replace(/^\n+/, "");
    if (name !== "") commit.push(name);
  }
  flush();
  return ordered;
}

/** A blob entry of `git ls-tree -r -z`: its mode and object id. */
interface TreeEntry {
  readonly mode: string;
  readonly id: string;
}

/** The entries of `git ls-tree -r -z <commit>` output by path. */
function treeEntries(output: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of splitZ(output)) {
    const tab = record.indexOf("\t");
    if (tab <= 0) continue;
    const [mode, , id] = record.slice(0, tab).split(" ");
    if (mode === undefined || id === undefined) continue;
    entries.set(record.slice(tab + 1), { mode, id });
  }
  return entries;
}

export interface CommitWorkspaceOptions {
  readonly git: OfficeGit;
  /** The commit whose tree the workspace reads. */
  readonly commit: string;
}

/**
 * A `Workspace` over the tree of a commit, read from git objects through the office's git queue:
 * no work tree is read, so a story needs no checkout of its own (0010). `root` is empty. A read
 * is refused for a path that leaves the tree, a secret path or a symbolic link; a submodule or a
 * folder reads as missing.
 */
export function commitWorkspace(options: CommitWorkspaceOptions): Workspace {
  const { git, commit } = options;
  const run = (args: readonly string[]) =>
    git.run((session) => session.ok(session.repository, args));
  let listed: Promise<Map<string, TreeEntry>> | null = null;
  const entries = (): Promise<Map<string, TreeEntry>> =>
    (listed ??= run(["ls-tree", "-r", "-z", "--full-tree", commit]).then(treeEntries));
  const paths = async (): Promise<readonly string[]> => [...(await entries()).keys()].toSorted();
  return {
    root: "",
    headSha: () => Promise.resolve(commit),
    trackedFiles: paths,
    files: paths,
    async readFile(path) {
      const clean = normalize(path);
      if (isAbsolute(clean) || clean === ".." || clean.startsWith(`..${sep}`)) {
        return refuse("path leaves the work tree");
      }
      if (isSecretPath(clean)) return refuse("secret path");
      const entry = (await entries()).get(clean.split(sep).join("/"));
      if (entry === undefined || entry.mode === "160000") return undefined;
      if (entry.mode === "120000") return refuse("symbolic link");
      return new TextEncoder().encode(await run(["cat-file", "blob", entry.id]));
    },
    filesByLastCommit: (sha, dir) => filesByLastCommitWith(run, sha, dir),
  };
}
