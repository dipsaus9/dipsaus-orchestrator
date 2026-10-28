// The box's own local repository (0008, DIPO-346). When dipo makes a box, after the code is copied
// into `/work`, it runs `git init` there and commits the start state, so tests and tools that need
// git work in the box. The repository shares nothing with the maintainer's: no refs, no config, no
// hooks, no remote and no history before the start state.
//
// - It is one fixed script of dipo's (`boxGitInitCommand`), run through the box interface's exec
//   as the box user in `/work`, within `BOX_GIT_INIT_TIMEOUT_MS`. It is the box's git, never the
//   Mac's: the git module (0010) and its lint rules are about git on the maintainer's repository,
//   and the Mac never runs git in a box folder.
// - It runs before the office's install and before the worker, from the image's git with no
//   system or user config, no hook templates (`--template=`), and no filter or hook the copied
//   files could name: a fresh repository's config has none.
// - The repository carries its own name and address for commits (`BOX_GIT_IDENTITY`), so a
//   worker's own `git commit` in the box works. What the worker does with it stays in the box:
//   every part leaves the box without `.git` (`partArchiveCommand`), and a part that carries a
//   `.git` path anyway is refused on the Mac (`protectedKind`).

import { BOX_WORKDIR } from "./code";
import { BoxError, type BoxPort } from "./port";

/** How long the `git init` and the start commit in a box may take. */
export const BOX_GIT_INIT_TIMEOUT_MS = 5 * 60_000;
/** The branch of the box's repository. */
export const BOX_GIT_BRANCH = "main";
/** The name and address the box's repository commits with. */
export const BOX_GIT_IDENTITY = { name: "dipo", email: "dipo@box.invalid" } as const;
/** The subject of the box repository's first commit. */
export const BOX_GIT_START_SUBJECT = "Start of the story";
/** The exit of the script when `/work` already holds a `.git`. */
export const BOX_GIT_EXISTS_EXIT = 3;

/**
 * The script that makes the box's repository: refused when `/work` already holds a `.git` of any
 * kind, else `git init` without templates, the repository's own identity, every file git does not
 * ignore added, and one commit with no hooks.
 */
export function boxGitInitCommand(): [string, string, string] {
  return [
    "/bin/sh",
    "-c",
    `set -eu
cd '${BOX_WORKDIR}'
if [ -e .git ] || [ -L .git ]; then echo "${BOX_WORKDIR} already holds .git" >&2; exit ${BOX_GIT_EXISTS_EXIT}; fi
git init -q --template= -b '${BOX_GIT_BRANCH}'
git config user.name '${BOX_GIT_IDENTITY.name}'
git config user.email '${BOX_GIT_IDENTITY.email}'
git add -A
git commit -q --no-verify --allow-empty -m '${BOX_GIT_START_SUBJECT}'`,
  ];
}

/** The environment of the script: git reads no system and no global config. */
export const BOX_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/**
 * Makes the box's repository in `/work` as the box user (see the file comment). Throws a
 * `BoxError` when the script fails; the caller deletes the box.
 */
export async function initBoxRepository(boxes: Pick<BoxPort, "exec">, box: string): Promise<void> {
  const result = await boxes.exec(box, boxGitInitCommand(), {
    cwd: BOX_WORKDIR,
    env: BOX_GIT_ENV,
    timeoutMs: BOX_GIT_INIT_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new BoxError(
      "box.failed",
      `the box's git repository could not be made (exit ${result.code}).`,
      false,
      { box, stderr: result.stderr.trim().slice(-2000) },
    );
  }
}
