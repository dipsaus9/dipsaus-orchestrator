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
// - A merge of the base that dipo copies into the box (a catch-up, DIPO-464) is committed in the
//   box's repository as a commit of its own (`commitInBoxRepository`), by a second fixed script
//   (`boxGitCatchUpCommand`): only the paths the merge wrote or removed go in, through a temporary
//   index read from the box's HEAD, so whatever the worker changed or staged elsewhere stays out of
//   it, and the box's own index takes the same paths, so the worker's `git log` shows the base's
//   changes and its `git diff` only its own work. A box without the repository (made before it, or
//   one whose `.git` is not a plain folder) commits nothing.

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

/** How long one step of the catch-up commit in a box may take. */
export const BOX_GIT_CATCH_UP_TIMEOUT_MS = 60_000;
/** How many paths one step of the catch-up commit names. */
const CATCH_UP_PATHS_PER_CALL = 100;
/** The box repository's temporary index of a catch-up commit, inside its `.git`. */
export const BOX_GIT_CATCH_UP_INDEX = ".git/dipo-catch-up-index";

/**
 * The script of one step of a catch-up commit in the box's repository (see the file comment), its
 * step and arguments after it as argv: `begin` reads HEAD into the temporary index and prints
 * HEAD; `add <path>...` takes the paths' state in `/work` into the temporary index and the box's
 * own index; `commit <subject> <head>` commits the temporary index on `<head>` and moves HEAD
 * from `<head>` only. It prints `none` when `/work/.git` is not a plain folder, and `same` when
 * the paths changed nothing.
 */
export function boxGitCatchUpCommand(
  step: "begin" | "add" | "commit",
  args: readonly string[],
): [string, ...string[]] {
  return [
    "/bin/sh",
    "-c",
    `set -eu
cd '${BOX_WORKDIR}'
if [ ! -d .git ] || [ -L .git ]; then echo none; exit 0; fi
ix='${BOX_GIT_CATCH_UP_INDEX}'
step=$1; shift
case "$step" in
begin)
  rm -f "$ix"
  GIT_INDEX_FILE="$ix" git read-tree HEAD
  git rev-parse --verify HEAD ;;
add)
  GIT_INDEX_FILE="$ix" git update-index --add --remove -- "$@"
  git update-index --add --remove -- "$@" ;;
commit)
  tree=$(GIT_INDEX_FILE="$ix" git write-tree)
  rm -f "$ix"
  if [ "$tree" = "$(git rev-parse --verify "$2^{tree}")" ]; then echo same; exit 0; fi
  next=$(git commit-tree "$tree" -p "$2" -m "$1")
  git update-ref -m "$1" HEAD "$next" "$2"
  echo "$next" ;;
*) exit 2 ;;
esac`,
    "dipo-box-git",
    step,
    ...args,
  ];
}

/**
 * Commits `paths` as `/work` holds them in the box's repository as one commit with `subject`
 * (see the file comment), as the box user. `none` when the box has no repository, `same` when
 * the paths changed nothing, else the commit. Throws a `BoxError` when a step fails.
 */
export async function commitInBoxRepository(
  boxes: Pick<BoxPort, "exec">,
  box: string,
  subject: string,
  paths: readonly string[],
): Promise<string> {
  const step = async (name: "begin" | "add" | "commit", args: readonly string[]) => {
    const result = await boxes.exec(box, boxGitCatchUpCommand(name, args), {
      cwd: BOX_WORKDIR,
      env: BOX_GIT_ENV,
      timeoutMs: BOX_GIT_CATCH_UP_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new BoxError(
        "box.failed",
        `the catch-up commit in the box's git repository failed at ${name} (exit ${result.code}).`,
        false,
        { box, stderr: result.stderr.trim().slice(-2000) },
      );
    }
    return result.stdout.trim();
  };
  if (paths.length === 0) return "same";
  const head = await step("begin", []);
  if (head === "none") return "none";
  for (let at = 0; at < paths.length; at += CATCH_UP_PATHS_PER_CALL) {
    await step("add", paths.slice(at, at + CATCH_UP_PATHS_PER_CALL));
  }
  return step("commit", [subject, head]);
}

/** What `boxBlobsCommand` prints for a path the box does not hold as a file or a link. */
export const BOX_PATH_MISSING = "missing";

/**
 * The script that prints git's blob id of each of its argv paths as `/work` holds them, one line
 * per path in order (DIPO-464): a file's content with no filter, a symlink's target, or
 * `BOX_PATH_MISSING`. It prints no path, so no file name can shape what dipo reads back.
 */
export function boxBlobsCommand(paths: readonly string[]): [string, ...string[]] {
  return [
    "/bin/sh",
    "-c",
    `set -eu
cd '${BOX_WORKDIR}'
shift
for p; do
  if [ -L "$p" ]; then printf '%s' "$(readlink -- "$p")" | git hash-object --stdin
  elif [ -f "$p" ]; then git hash-object --no-filters -- "$p"
  else echo '${BOX_PATH_MISSING}'; fi
done`,
    "dipo-box-git-blobs",
    "blobs",
    ...paths,
  ];
}

/**
 * Git's blob id of each of `paths` as the box's `/work` holds them (`boxBlobsCommand`), or
 * `BOX_PATH_MISSING`, as the box user. Throws a `BoxError` when the script fails or prints
 * another number of lines.
 */
export async function boxBlobs(
  boxes: Pick<BoxPort, "exec">,
  box: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let at = 0; at < paths.length; at += CATCH_UP_PATHS_PER_CALL) {
    const group = paths.slice(at, at + CATCH_UP_PATHS_PER_CALL);
    const result = await boxes.exec(box, boxBlobsCommand(group), {
      cwd: BOX_WORKDIR,
      env: BOX_GIT_ENV,
      timeoutMs: BOX_GIT_CATCH_UP_TIMEOUT_MS,
    });
    const lines = result.stdout.split("\n").filter((line) => line !== "");
    if (result.code !== 0 || lines.length !== group.length) {
      throw new BoxError(
        "box.failed",
        `the box's files could not be compared with the story branch (exit ${result.code}).`,
        false,
        { box, stderr: result.stderr.trim().slice(-2000) },
      );
    }
    group.forEach((path, n) => found.set(path, lines[n]!));
  }
  return found;
}
