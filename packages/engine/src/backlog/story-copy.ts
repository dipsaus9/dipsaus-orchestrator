// dipo's own copy of a story's backlog (0010 section 2): every Backlog CLI call for a claimed story
// runs in a fresh folder that holds only two files read from git objects, the Backlog configuration
// from the office's base and the story's task file as committed at the tip of its branch. No work
// tree of any kind is read or written: a story has no Mac worktree, and the box's files never reach
// this folder. The StoryStore's story lane (`store.ts`) runs every read and edit on a branch here.
//
// An edit commits the task file the CLI left there alone on top of the branch tip: its blob is
// stored with `git hash-object -w`, put into a temporary index built from the tip
// (`git update-index --cacheinfo`), committed with `git commit-tree`, and the branch moves from the
// tip it was read at (`git update-ref`, through the git module). A branch that moved meanwhile is
// refused, so no commit is lost. The folder shares the branch reads' prefix, so the claims load
// step sweeps one a killed daemon left behind (`worktree/sweep.ts`). Runs inside a queue item of
// the office git.

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { BASE_CHECKOUT_ENV } from "../git/hardened";
import type { GitSession, OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import { branchTip, commitTree, moveBranch } from "../git/write";
import { TASK_FIELD_ERROR } from "../story-store/errors";
import type { StoryEdit, StoryOnBranch } from "../story-store/store";
import { BRANCH_READ_PREFIX } from "../worktree/sweep";

import {
  BACKLOG_FOLDER_ERROR,
  isTaskFileOf,
  taskFieldRefusal,
  taskFilePathRefusal,
  TASKS_DIR,
} from "./runner";

/** The Backlog configuration, relative to the repository root. */
const BACKLOG_CONFIG = "backlog/config.yml";

/** The task file mode dipo commits; a task file of any other mode is refused. */
const TASK_FILE_MODE = "100644";

/** dipo's own copy of a story's backlog, where every Backlog CLI call for the story runs. */
export interface StoryBacklog {
  /** The folder the CLI runs in: it holds only the Backlog configuration and the task file. */
  readonly cwd: string;
  /** Repo-relative path of the story's task file. */
  readonly taskFile: string;
}

/**
 * The commit of the office's base branch: `<remote>/<base>`, else the local `<base>` (an office
 * without a fetched remote). Runs inside a queue item of `git`.
 */
async function baseCommit(git: OfficeGit, session: GitSession): Promise<string> {
  const base = await git.resolveBaseIn(session);
  const refs = [`refs/remotes/${git.settings.remote}/${base}`, `refs/heads/${base}`];
  for (const ref of refs) {
    const found = await session.step(session.repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    if (found.code === 0) return found.stdout.trim();
  }
  throw new GitError(
    "git.baseMissing",
    `Neither ${refs.join(" nor ")} exists, so dipo has no Backlog configuration to run the CLI with.`,
    false,
    { refs },
  );
}

/** Reads the story with the Backlog CLI in dipo's own copy of its backlog; nothing is written. */
export async function inStoryBacklog<T>(
  git: OfficeGit,
  session: GitSession,
  target: StoryOnBranch,
  fn: (backlog: StoryBacklog) => Promise<T>,
): Promise<T> {
  return (await inStoryBacklogCopy(git, session, target, null, fn)).value;
}

/**
 * Edits the story with the Backlog CLI in dipo's own copy of its backlog, then commits the task
 * file the CLI left as `message` alone on its branch.
 */
export function editInStoryBacklog<T>(
  git: OfficeGit,
  session: GitSession,
  target: StoryOnBranch,
  message: string,
  fn: (backlog: StoryBacklog) => Promise<T>,
): Promise<StoryEdit<T>> {
  return inStoryBacklogCopy(git, session, target, message, fn);
}

/**
 * Runs `fn` with dipo's own copy of the backlog of `story` (see the file comment). The task file
 * must sit directly in `backlog/tasks` (`taskFilePathRefusal`) and hold only fields dipo knows
 * (`taskFieldRefusal`), else the operation is refused before the CLI runs.
 */
async function inStoryBacklogCopy<T>(
  git: OfficeGit,
  session: GitSession,
  target: StoryOnBranch,
  message: string | null,
  fn: (backlog: StoryBacklog) => Promise<T>,
): Promise<StoryEdit<T>> {
  const { branch, story } = target;
  const head = await branchTip(session, branch);
  const taskFile = await storyTaskFileAt(session, head, story);
  const committed = await session.ok(session.repository, ["show", `${head}:${taskFile}`]);
  const refused = taskFieldRefusal(committed);
  if (refused !== null) {
    throw new GitError(
      TASK_FIELD_ERROR,
      `dipo refuses ${story}'s task file ${taskFile} at ${head}: ${refused}.`,
      false,
      { story, taskFile, head },
    );
  }
  const base = await baseCommit(git, session);
  const config = await session.ok(session.repository, ["show", `${base}:${BACKLOG_CONFIG}`]);
  const root = git.worktreeRoot();
  mkdirSync(root, { recursive: true });
  const scratch = mkdtempSync(join(root, BRANCH_READ_PREFIX));
  try {
    // The CLI's folder is a child of the scratch folder, which also holds the temporary index.
    const cwd = join(scratch, "copy");
    for (const [path, text] of [
      [BACKLOG_CONFIG, config],
      [taskFile, committed],
    ] as const) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), text, { flag: "wx" });
    }
    const value = await fn({ cwd, taskFile });
    if (message === null) return { value, commit: null };
    const left = readdirSync(join(cwd, dirname(taskFile))).filter((name) =>
      isTaskFileOf(name, story),
    );
    if (left.length !== 1 || left[0] !== basename(taskFile)) {
      throw new GitError(
        BACKLOG_FOLDER_ERROR,
        `The Backlog CLI left ${left.join(", ") || "no task file"} for ${story}, not ${taskFile}.`,
        false,
        { story, taskFile, left },
      );
    }
    const commit = await commitFromCopy(session, {
      branch,
      head,
      taskFile,
      file: join(cwd, taskFile),
      index: join(scratch, "index"),
      message,
    });
    return { value, commit };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The story's task file at `head`: exactly one, directly in `backlog/tasks`. */
async function storyTaskFileAt(session: GitSession, head: string, story: string): Promise<string> {
  const listed = await session.ok(session.repository, [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    head,
    "--",
    TASKS_DIR,
  ]);
  const files = listed.split("\0").filter((path) => isTaskFileOf(basename(path), story));
  const [taskFile] = files;
  if (taskFile === undefined || files.length > 1) {
    throw new GitError(
      BACKLOG_FOLDER_ERROR,
      `${head} holds ${files.length === 0 ? "no" : "more than one"} task file for ${story} under ${TASKS_DIR}.`,
      false,
      { story, files },
    );
  }
  const badPath = taskFilePathRefusal(taskFile);
  if (badPath !== null) {
    throw new GitError(
      BACKLOG_FOLDER_ERROR,
      `${story}'s task file at ${head}: ${badPath}.`,
      false,
      {
        story,
        taskFile,
      },
    );
  }
  return taskFile;
}

/**
 * Commits the blob of `file` as `taskFile` alone on top of `head` and moves `branch` there from
 * `head` (see the file comment). Returns the commit, or null when the blob equals the committed one.
 */
async function commitFromCopy(
  session: GitSession,
  input: {
    readonly branch: string;
    readonly head: string;
    readonly taskFile: string;
    readonly file: string;
    readonly index: string;
    readonly message: string;
  },
): Promise<string | null> {
  const { head, taskFile } = input;
  const repo = session.repository;
  const entry = (await session.ok(repo, ["ls-tree", "-z", head, "--", taskFile])).split("\t")[0];
  const [mode, type, before] = entry?.split(" ") ?? [];
  if (mode !== TASK_FILE_MODE || type !== "blob" || before === undefined) {
    throw new GitError(
      BACKLOG_FOLDER_ERROR,
      `${taskFile} at ${head} is not a plain file (mode ${mode ?? "none"}), so dipo does not commit it.`,
      false,
      { taskFile, mode },
    );
  }
  const blob = (
    await session.ok(repo, ["hash-object", "-w", "--no-filters", "--", input.file])
  ).trim();
  if (blob === before) return null;
  const temporary = { env: { ...BASE_CHECKOUT_ENV, GIT_INDEX_FILE: input.index } };
  await session.ok(repo, ["read-tree", head], temporary);
  await session.ok(
    repo,
    ["update-index", "--cacheinfo", `${TASK_FILE_MODE},${blob},${taskFile}`],
    temporary,
  );
  const tree = (await session.ok(repo, ["write-tree"], temporary)).trim();
  const commit = await commitTree(session, repo, {
    tree,
    parents: [head],
    message: { subject: input.message },
  });
  if (!(await moveBranch(session, input.branch, commit, head, input.message))) {
    throw new GitError(
      "git.failed",
      `refs/heads/${input.branch} moved from ${head} while dipo committed ${taskFile}, so the commit was not kept.`,
      false,
      { branch: input.branch, head },
    );
  }
  return commit;
}

/** `file` (absolute, as the CLI printed it) relative to the copy's folder, with `/` separators. */
export function repoPath(folder: string, file: string): string {
  const rel = relative(realOr(folder), realOr(file));
  if (rel === "" || isAbsolute(rel) || rel.startsWith("..") || !rel.startsWith(`backlog${sep}`)) {
    throw new GitError(
      "claim.scope",
      `The Backlog CLI named ${file} as the task file, which is not under ${folder}/backlog.`,
      false,
      { file },
    );
  }
  return rel.split(sep).join("/");
}

/** The real path of `path`, or `path` itself when it cannot be resolved. */
function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
