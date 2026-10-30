// A story's task file as git holds it (0010): where Backlog.md keeps it and what its front matter
// says, read from git objects. The engine asks for these through the StoryStore (`fileAt`,
// `lastFileCommit`, `statusIn`), never by the layout itself.

import type { GitSession } from "../git/office";

import { BACKLOG_FOLDER, isTaskFileOf, TASKS_DIR } from "./runner";

/** The story's task file at `commit`: the one file of `story` directly in `backlog/tasks`. */
export async function taskFileAt(
  session: GitSession,
  commit: string,
  story: string,
): Promise<string | null> {
  const listed = (
    await session.ok(session.repository, [
      "ls-tree",
      "-z",
      "--name-only",
      commit,
      "--",
      `${TASKS_DIR}/`,
    ])
  )
    .split("\0")
    .filter((path) => path !== "" && isTaskFileOf(path.slice(path.lastIndexOf("/") + 1), story));
  return listed.length === 1 ? (listed[0] as string) : null;
}

/**
 * The commit of `ref` that last changed the task file of `story` (`backlog/**\/<id> - *.md`, in any
 * of its folders and any case), or null when git finds none.
 */
export async function lastTaskFileCommit(
  session: GitSession,
  ref: string,
  story: string,
): Promise<string | null> {
  const result = await session.step(session.repository, [
    "log",
    "-1",
    "--format=%H",
    ref,
    "--",
    `:(glob,icase)${BACKLOG_FOLDER}/**/${story} - *.md`,
  ]);
  const sha = result.code === 0 ? result.stdout.trim() : "";
  return sha === "" ? null : sha;
}

/** Pure: the `status:` of a task file's front matter, or null when it has none. */
export function taskFileStatus(text: string): string | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front === null) return null;
  const line = /^status:[ \t]*(.+?)[ \t]*\r?$/m.exec(front[1] ?? "");
  const value = line?.[1]?.replace(/^(["'])(.*)\1$/, "$2").trim() ?? "";
  return value === "" ? null : value;
}
