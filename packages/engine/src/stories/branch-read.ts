// Reading a claimed story at its branch tip (DIPO-56, 0007 section 6 step 3; 0010 section 2a).
// The story's lifecycle fact is what is committed on its branch, never the claim worktree's working
// tree, where the worker may have edited the task file without a commit. The engine materialises
// the branch's view of the backlog in a scratch directory and reads the story there with the
// Backlog CLI, through the same parser as every other read:
//
// - `backlog/` is copied from the `_base` checkout: a story branch may change only the story's own
//   task file (0010 section 2a), so every other file, the configuration and the dependencies read
//   as on the base;
// - the story's own task file is replaced by the committed one, `git show <branch>:<path>`, found
//   with `git ls-tree` on the branch ref (the file name follows the title, so it may differ).
//
// The scratch directory is `<worktree root>/_branch-read-*`, outside any git repository, and is
// removed after the read. Runs inside a queue item of the office git. A daemon killed mid-read
// leaves the directory behind; the claims load step sweeps it at the next office load (DIPO-90,
// `worktree/sweep.ts`).

import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { type BacklogCli, TASK_FIELD_ERROR, taskFieldRefusal } from "../backlog/runner";
import type { GitSession, OfficeGit } from "../git/office";
import { GitError } from "../git/runner";
import type { ClaimRecord } from "../worktree/records";

import { type BacklogStory, readStory } from "./read";

/** The Backlog.md project directory in a checkout. */
const BACKLOG_DIR = "backlog";

/** The prefix of the scratch directories under the worktree root. */
export const BRANCH_READ_PREFIX = "_branch-read-";

/** True when `name` is the task file of `id`: `<id> - <title>.md`, any case. */
function isTaskFileOf(name: string, id: string): boolean {
  return name.toLowerCase().startsWith(`${id.toLowerCase()} - `) && name.endsWith(".md");
}

/** The repository path of the story's task file on `ref`; throws when there is none. */
async function taskFileOn(session: GitSession, ref: string, id: string): Promise<string> {
  const listed = await session.ok(session.repository, [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    ref,
    "--",
    `${BACKLOG_DIR}/tasks`,
  ]);
  const files = listed.split("\0").filter((path) => isTaskFileOf(basename(path), id));
  const [only] = files;
  if (only === undefined) throw new Error(`${ref} has no task file for ${id}`);
  if (files.length > 1) throw new Error(`${ref} has more than one task file for ${id}`);
  return only;
}

/**
 * Reads the story of `claim` as committed on its branch, with `basePath` (the `_base` checkout)
 * for the rest of the backlog. Must run inside a queue item of `git` (`session`); throws when the
 * branch ref or its task file is missing, when the task file holds fields dipo does not know
 * (`TASK_FIELD_ERROR`, before the CLI runs), or when the Backlog CLI fails.
 */
export async function readOnBranch(
  git: OfficeGit,
  session: GitSession,
  cli: BacklogCli,
  claim: ClaimRecord,
  basePath: string,
  listed: { readonly id: string; readonly title: string; readonly status: string },
): Promise<BacklogStory> {
  const ref = `refs/heads/${claim.branch}`;
  const path = await taskFileOn(session, ref, listed.id);
  const content = await session.ok(session.repository, ["show", `${ref}:${path}`]);
  // A task file holding fields dipo does not know never reaches the CLI (0021 section 14): the
  // read fails with the coded error, so the index lists the story as unread on its branch.
  const refused = taskFieldRefusal(content);
  if (refused !== null) {
    throw new GitError(
      TASK_FIELD_ERROR,
      `dipo refuses ${listed.id}'s task file ${path} on ${claim.branch}: ${refused}.`,
      false,
      { story: listed.id, taskFile: path, branch: claim.branch },
    );
  }
  const root = git.worktreeRoot();
  mkdirSync(root, { recursive: true });
  const scratch = mkdtempSync(join(root, BRANCH_READ_PREFIX));
  try {
    const backlog = join(scratch, BACKLOG_DIR);
    cpSync(join(basePath, BACKLOG_DIR), backlog, { recursive: true });
    const tasks = join(backlog, "tasks");
    mkdirSync(tasks, { recursive: true });
    for (const name of readdirSync(tasks)) {
      if (isTaskFileOf(name, listed.id)) rmSync(join(tasks, name), { force: true });
    }
    const target = join(scratch, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    const story = await readStory(cli, scratch, "task", listed);
    return { ...story, source: claim.branch };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
