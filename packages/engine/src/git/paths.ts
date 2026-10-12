// The worktree root (0010 section 7, open question 4): `worktree.root` from office configuration,
// default `../{repo}.worktrees`, resolved against the main checkout to an absolute path. It must
// lie outside the main checkout (0008), so Node module resolution and indexers never walk from a
// worktree into the maintainer's checkout. The engine's worktrees sit directly under it:
// `<root>/<ID>`, `<root>/_backlog` and `<root>/_base`.

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { GitError } from "./runner";

export const DEFAULT_WORKTREE_ROOT = "../{repo}.worktrees";
/** The detached read worktree at `origin/<base>` (0010 section 2). */
export const BASE_WORKTREE = "_base";

/** The canonical form of `path`: the real path of its nearest existing ancestor, plus the rest. */
export function canonicalFuturePath(path: string): string {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.toReversed());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** True when `path` is `dir` or lies under it. */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * The absolute worktree root for the main checkout `mainWorktree` (canonical), with `{repo}`
 * replaced by the checkout's directory name. Refuses with `git.rootInsideCheckout` when the root
 * resolves to the main checkout or under it.
 */
export function resolveWorktreeRoot(mainWorktree: string, configured?: string): string {
  const template = configured ?? DEFAULT_WORKTREE_ROOT;
  const raw = template.replaceAll("{repo}", basename(mainWorktree));
  const root = canonicalFuturePath(resolve(mainWorktree, raw));
  const main = canonicalFuturePath(mainWorktree);
  if (isInside(root, main)) {
    throw new GitError(
      "git.rootInsideCheckout",
      `The worktree root ${root} (worktree.root ${JSON.stringify(template)}) lies inside the main checkout ${main}; set worktree.root in .dipo/office.yaml to a directory outside it, such as ${JSON.stringify(DEFAULT_WORKTREE_ROOT)}.`,
      false,
      { root, mainWorktree: main },
    );
  }
  return root;
}
