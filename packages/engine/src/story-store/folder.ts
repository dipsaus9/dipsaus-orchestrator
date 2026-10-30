// Where a story store keeps its stories, read for its lookup (`StoryStore.storyFolders`, 0010,
// DIPO-379): the readers a lookup reads a repository's files through, a checkout's or a tree's
// from git objects, and how a guard tells a lookup that refuses. The comparison of a path with the
// folders is `paths.ts`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { GitSession } from "../git/office";
import type { GitTreeEntry } from "../git/tree";

import { StoryStoreError } from "./errors";
import { foldName, repoPathOf } from "./paths";

/**
 * Reads a repository's file by its repo-relative path: its text, or null when the repository holds
 * no such file. It throws when it cannot tell (a read that fails, a link, a file too large), and a
 * store's lookup through it then throws too, so a guard that asks refuses.
 */
export type RepoFileRead = (path: string) => Promise<string | null>;

/**
 * Reads the files of the checkout at `dir`: a missing file is null; any other failure throws, so a
 * lookup through it refuses.
 */
export function checkoutFiles(dir: string): RepoFileRead {
  return async (path) => {
    const inside = repoPathOf(path);
    if (inside === null || inside === "")
      throw new StoryFileRefusedError(path, "is no file of the repository");
    try {
      return await readFile(join(dir, inside), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
}

/**
 * True when `error`, thrown by a store's folder lookup, is the store refusing to tell (a
 * configuration it cannot resolve, a file it does not read), not a failure to retry: a guard then
 * refuses for good.
 */
export function folderLookupRefused(error: unknown): boolean {
  return error instanceof StoryStoreError;
}

/** A file a folder lookup does not read (`treeFiles`): the lookup refuses. */
export class StoryFileRefusedError extends StoryStoreError {
  constructor(path: string, why: string) {
    super(`${JSON.stringify(path)} ${why}, so dipo does not read it.`);
    this.name = "StoryFileRefusedError";
  }
}

/** The largest file `treeFiles` reads; a configuration file is far smaller. */
export const TREE_FILE_MAX = 64 * 1024;

/**
 * Reads the files of the tree `entries` (`git/tree.ts`, or a view built from it) by repo-relative
 * path, from git objects inside the office's git queue item `session`: the text, or null when the
 * tree holds none. A path is found as the Mac's case-insensitive volume would find it; a path two
 * entries fold to, a link, a submodule or a file over `TREE_FILE_MAX` refuses
 * (`StoryFileRefusedError`).
 */
export function treeFiles(
  session: GitSession,
  entries: ReadonlyMap<string, GitTreeEntry>,
): RepoFileRead {
  return async (path) => {
    const want = foldName(repoPathOf(path) ?? path);
    const found = [...entries].filter(([own]) => foldName(own) === want);
    if (found.length === 0) return null;
    if (found.length > 1)
      throw new StoryFileRefusedError(path, "names more than one file of the tree");
    const [, entry] = found[0]!;
    if (entry.type !== "blob" || entry.mode === "120000") {
      throw new StoryFileRefusedError(path, "is not a regular file");
    }
    const size = Number(
      (await session.ok(session.repository, ["cat-file", "-s", entry.id])).trim(),
    );
    if (!(size <= TREE_FILE_MAX)) {
      throw new StoryFileRefusedError(path, `is larger than ${TREE_FILE_MAX} bytes`);
    }
    return session.ok(session.repository, ["cat-file", "blob", entry.id]);
  };
}
