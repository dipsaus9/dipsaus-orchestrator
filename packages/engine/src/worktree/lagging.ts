// A box run's Mac worktree that only lags its branch (DIPO-332, after DIPO-302; 0021 sections 8
// and 14). dipo commits a box run's parts and its catch-up merges on the story branch from git
// objects, moving the branch with `update-ref` and never touching the Mac worktree's files, while
// its own task-file commits write the task file there (`inStoryBacklogCopy`). So the worktree holds
// the claim's code files next to a later task file, and `git status` lists every file the parts
// delivered, as modified, added or deleted. None of that is work: each such file equals the file of
// a commit dipo made, which the branch history keeps.
//
// `unlaggedPaths` proves it path by path. Each path `git status` lists is compared, for its working
// file (content and mode, or its absence) and for its index entry, with that path in the commits
// that may hold it: the claim's start commit, its claim commit, and the first-parent commits the
// branch tip and the recorded heads (the PR's last pushed head, for a branch already gone) hold
// above the start commit. A path whose working file or index entry matches none of them is a
// change only the worktree holds and is returned, so the caller keeps the worktree and lists it.
// The comparison never runs a filter or a tool on the worktree's files: dipo reads them itself and
// hashes them as git blobs; a symbolic link is compared as a link (its target), never followed,
// and a path below a link is absent, as git reads it. Anything it cannot judge keeps the worktree:
// an unmerged entry, an index entry marked assume-unchanged or skip-worktree (git status would not
// list a change behind it), a submodule (an index entry of mode 160000: git status may hide its
// changes and commits, `submodule.<name>.ignore`), a folder or special file where a file is listed,
// a nested repository, or a git error.
//
// Ignored files are not in `git status`, but `git worktree remove` deletes them, forced or not.
// `keptIgnored` lists them (`ls-files --others --ignored --exclude-standard --directory`): every
// entry outside `REBUILDABLE_IGNORED` (an install or a build makes it again) keeps the worktree, and
// so does an ignored folder that holds a repository (`.git`), wherever it is.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { join } from "node:path";

import type { GitSession, OfficeGit } from "../git/office";

/** The most branch commits one head adds to the comparison; older ones are left out. */
export const LAG_COMMITS_MAX = 500;

/** The most paths one `ls-tree` is given; with more wanted, the whole tree is listed. */
const LITERAL_PATHS_MAX = 256;

/**
 * The ignored entries a worktree removal may delete (DIPO-332): folders that an install or a build
 * of the office makes again, by name at any depth (`node_modules/` of every package manager, the
 * usual build, cache and coverage output), and the macOS folder metadata file. Anything else
 * ignored, such as `.env` or a local database, keeps the worktree.
 */
export const REBUILDABLE_IGNORED = {
  folders: new Set([
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".turbo",
    ".cache",
    ".next",
    ".vite",
  ]),
  files: new Set([".DS_Store"]),
} as const;

/** A path's entry: absent, or its mode and blob (or commit, for a submodule) id. */
type Entry = { readonly mode: string; readonly id: string } | null;

/** The claim facts the comparison reads. */
export interface LagClaim {
  readonly worktree: string;
  readonly branch: string;
  readonly startSha: string;
  readonly claimSha?: string | null;
}

/** Unmerged `git status` codes (porcelain v1). */
const UNMERGED: ReadonlySet<string> = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * The paths `git status` lists in the claim's worktree that hold a change no commit of the claim
 * has (see the file comment): empty when every listed path only lags the branch, null when dipo
 * cannot judge, so the caller keeps the worktree and lists what git lists. `heads` are more commits
 * whose first-parent history dipo made, such as the PR's last pushed head.
 */
export async function unlaggedPaths(
  officeGit: Pick<OfficeGit, "worktreeLocation">,
  git: GitSession,
  claim: LagClaim,
  heads: readonly string[] = [],
): Promise<string[] | null> {
  try {
    const location = officeGit.worktreeLocation(claim.worktree);
    const listed = statusRecords(
      await git.ok(location, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ]),
    );
    if (listed === null) return null;
    if (listed.length === 0) return [];
    const index = indexEntries(await git.ok(location, ["ls-files", "--stage", "-v", "-z"]));
    if (index === null) return null;
    const format = (await git.ok(git.repository, ["rev-parse", "--show-object-format"])).trim();
    if (format !== "sha1" && format !== "sha256") return null;

    // Each path needs its working file and its index entry found in some commit (not always the same).
    const wanted = new Map<string, Entry[]>();
    for (const path of listed) {
      const working = workingEntry(claim.worktree, path, format);
      if (working === undefined) return null;
      wanted.set(path, [working, index.get(path) ?? null]);
    }
    for (const commit of await lagCommits(git, claim, heads)) {
      if (wanted.size === 0) break;
      // Only the wanted paths, as literal pathspecs, while they are few: a kept claim repeats this on
      // every Done poll inside the office git queue.
      const only =
        wanted.size <= LITERAL_PATHS_MAX
          ? ["--", ...[...wanted.keys()].map((path) => `:(literal)${path}`)]
          : [];
      const tree = await git.step(git.repository, ["ls-tree", "-r", "-z", commit, ...only]);
      if (tree.code !== 0) continue;
      const entries = treeEntries(tree.stdout);
      for (const [path, states] of wanted) {
        const at = entries.get(path) ?? null;
        const left = states.filter((state) => !sameEntry(state, at));
        if (left.length === 0) wanted.delete(path);
        else wanted.set(path, left);
      }
    }
    return listed.filter((path) => wanted.has(path));
  } catch {
    return null;
  }
}

/** The start commit, the claim commit and the first-parent commits of the tip and `heads` above the start. */
async function lagCommits(
  git: GitSession,
  claim: LagClaim,
  heads: readonly string[],
): Promise<string[]> {
  const commits = new Set<string>();
  const start = claim.startSha;
  if (OBJECT_ID.test(start)) commits.add(start);
  if (claim.claimSha != null && OBJECT_ID.test(claim.claimSha)) commits.add(claim.claimSha);
  const tip = await git.step(git.repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${claim.branch}^{commit}`,
  ]);
  const tops = [tip.code === 0 ? tip.stdout.trim() : "", ...heads];
  for (const top of new Set(tops)) {
    if (!OBJECT_ID.test(top)) continue;
    const listed = await git.step(git.repository, [
      "rev-list",
      "--first-parent",
      `--max-count=${LAG_COMMITS_MAX}`,
      "--end-of-options",
      top,
      ...(OBJECT_ID.test(start) ? [`^${start}`] : []),
    ]);
    if (listed.code !== 0) continue;
    for (const line of listed.stdout.split("\n")) {
      const sha = line.trim();
      if (OBJECT_ID.test(sha)) commits.add(sha);
    }
  }
  return [...commits];
}

/**
 * The paths of `status --porcelain=v1 -z --no-renames`, each once (a path deleted in the index and
 * present as an untracked file has two records), or null when one is unmerged.
 */
function statusRecords(output: string): string[] | null {
  const paths = new Set<string>();
  for (const record of output.split("\0")) {
    if (record === "") continue;
    if (UNMERGED.has(record.slice(0, 2))) return null;
    paths.add(record.slice(3));
  }
  return [...paths];
}

/**
 * The ignored entries of the worktree a removal would delete that are not rebuildable (see the file
 * comment), sorted; null when they cannot be listed.
 */
export async function keptIgnored(
  officeGit: Pick<OfficeGit, "worktreeLocation">,
  git: GitSession,
  worktree: string,
): Promise<string[] | null> {
  try {
    const out = await git.ok(officeGit.worktreeLocation(worktree), [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
    return out
      .split("\0")
      .filter((entry) => entry !== "" && !rebuildable(worktree, entry))
      .toSorted();
  } catch {
    return null;
  }
}

/** True when an ignored entry is rebuildable and holds no repository. */
function rebuildable(worktree: string, entry: string): boolean {
  const folder = entry.endsWith("/");
  if (folder && existsSync(join(worktree, entry, ".git"))) return false;
  const parts = entry.split("/").filter((part) => part !== "");
  const last = parts.at(-1) ?? "";
  if (parts.slice(0, -1).some((part) => REBUILDABLE_IGNORED.folders.has(part))) return true;
  return folder ? REBUILDABLE_IGNORED.folders.has(last) : REBUILDABLE_IGNORED.files.has(last);
}

/**
 * The index entries of `ls-files --stage -v -z` by path, or null when one is not a plain cached
 * entry at stage 0 (assume-unchanged, skip-worktree, unmerged) or is a submodule (mode 160000).
 */
function indexEntries(output: string): Map<string, Entry> | null {
  const entries = new Map<string, Entry>();
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [tag, mode, id, stage] = record.slice(0, tab).split(" ");
    if (tab < 0 || tag !== "H" || stage !== "0" || mode === undefined || id === undefined) {
      return null;
    }
    if (mode === "160000") return null;
    entries.set(record.slice(tab + 1), { mode, id });
  }
  return entries;
}

/** The entries of `ls-tree -r -z` by path. */
function treeEntries(output: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , id] = record.slice(0, tab).split(" ");
    if (mode !== undefined && id !== undefined) entries.set(record.slice(tab + 1), { mode, id });
  }
  return entries;
}

function sameEntry(a: Entry, b: Entry): boolean {
  return a === null || b === null ? a === b : a.mode === b.mode && a.id === b.id;
}

/**
 * The working file of `path` as git would store it: null when absent (also below a non-folder,
 * as git reads it), its mode and blob id for a file or a link, undefined when dipo cannot judge it
 * (a folder, a nested repository, a special file, an unreadable path).
 */
function workingEntry(root: string, path: string, format: "sha1" | "sha256"): Entry | undefined {
  if (path === "" || path.endsWith("/")) return undefined;
  const parts = path.split("/");
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const stat = lstatOrNull(dir);
    if (stat === undefined) return undefined;
    if (stat === null || !stat.isDirectory()) return null;
  }
  const full = join(root, path);
  const stat = lstatOrNull(full);
  if (stat === undefined) return undefined;
  if (stat === null) return null;
  if (stat.isSymbolicLink()) {
    return { mode: "120000", id: blobId(format, readlinkSync(full, { encoding: "buffer" })) };
  }
  if (stat.isFile()) {
    const mode = (stat.mode & 0o100) === 0 ? "100644" : "100755";
    return { mode, id: blobId(format, readFileSync(full)) };
  }
  return undefined;
}

/** `lstat`, null when the path does not exist, undefined when it cannot be read. */
function lstatOrNull(path: string): Stats | null | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : undefined;
  }
}

/** The git blob id of `content`. */
function blobId(format: "sha1" | "sha256", content: Uint8Array): string {
  return createHash(format).update(`blob ${content.length}\0`).update(content).digest("hex");
}
