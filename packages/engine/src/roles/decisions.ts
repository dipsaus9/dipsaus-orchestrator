// The decision files as committed on the office's base (DIPO-505), read from git's objects at
// `<remote>/<base>` as the role files are (0017). A planning proposal's ADR quotes are checked
// against them.

import { baseCommit, filesAt } from "../box/image";

import type { OfficeGit } from "../git/office";

export const DECISIONS_DIR = "docs/decisions";

/** The decision files of the base at one commit: the text of each, by path. */
export interface BaseDecisions {
  readonly commit: string;
  readonly files: ReadonlyMap<string, string | undefined>;
}

/**
 * The `.md` files directly under `docs/decisions/` at the commit `<remote>/<base>` points at. Null
 * when the office has no base yet, or when that commit is `seen` already.
 */
export function readBaseDecisions(
  git: OfficeGit,
  seen: string | undefined,
): Promise<BaseDecisions | null> {
  return git.run(async (session) => {
    const commit = await baseCommit(git, session)
      .then((found) => found.commit)
      .catch(() => null);
    if (commit === null || commit === "" || commit === seen) return null;
    const listed = await session.ok(session.repository, [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      "--full-tree",
      commit,
      "--",
      `${DECISIONS_DIR}/`,
    ]);
    const paths = listed
      .split("\0")
      .filter(
        (path) =>
          path.startsWith(`${DECISIONS_DIR}/`) &&
          path.endsWith(".md") &&
          !path.slice(DECISIONS_DIR.length + 1).includes("/"),
      );
    const read = await filesAt(session, commit, paths);
    return { commit, files: new Map(paths.map((path) => [path, read.get(path)?.text])) };
  });
}
