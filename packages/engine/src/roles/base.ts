// The role files as committed on the office's base (0017), read from git's objects at
// `<remote>/<base>`, never from a checkout, as `.dipo/office.yaml` is. The roster is the valid
// files; an invalid file is left out and reported as a problem naming the file.

import type { GateRole } from "../gate/types";
import { baseCommit, filesAt } from "../box/image";
import type { OfficeGit } from "../git/office";

import { parseRoleFile, ROLES_DIR, type Role } from "./parse";

export interface BaseRoles {
  readonly roles: readonly Role[];
  /** One message per refused file, each naming it, in path order. */
  readonly problems: readonly string[];
  /** The text of every file read, by path: what a later poll compares to see a change. */
  readonly files: ReadonlyMap<string, string | undefined>;
}

/** The roster the gate reads: a role is a code role when its kind is `code`. */
export function rosterOf(roles: readonly Role[]): GateRole[] {
  return roles.map((role) => ({ name: role.name, code: role.kind === "code", kind: role.kind }));
}

/** Parses role files by path; a refused file becomes a problem, the rest become roles. */
export function loadRoleFiles(files: ReadonlyMap<string, string | undefined>): BaseRoles {
  const roles: Role[] = [];
  const problems: string[] = [];
  for (const path of [...files.keys()].toSorted()) {
    const text = files.get(path);
    if (text === undefined) {
      problems.push(`${path}: not a regular file`);
      continue;
    }
    const parsed = parseRoleFile(path, text);
    if (parsed.ok) roles.push(parsed.role);
    else problems.push(parsed.message);
  }
  return { roles, problems, files };
}

/**
 * The role files at the commit `<remote>/<base>` points at, one queue item of the office git. Null
 * when the office has no base branch or ref yet: the load already reports that.
 */
export function readBaseRoles(git: OfficeGit): Promise<BaseRoles | null> {
  return git.run(async (session) => {
    const commit = await baseCommit(git, session)
      .then((found) => found.commit)
      .catch(() => null);
    if (commit === null || commit === "") return null;
    const listed = await session.ok(session.repository, [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      "--full-tree",
      commit,
      "--",
      `${ROLES_DIR}/`,
    ]);
    const paths = listed
      .split("\0")
      .filter(
        (path) =>
          path.startsWith(`${ROLES_DIR}/`) &&
          path.endsWith(".md") &&
          !path.slice(ROLES_DIR.length + 1).includes("/"),
      );
    const read = await filesAt(session, commit, paths);
    return loadRoleFiles(new Map(paths.map((path) => [path, read.get(path)?.text])));
  });
}
