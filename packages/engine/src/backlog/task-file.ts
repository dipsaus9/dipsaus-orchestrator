// A story's task file as git holds it (0010): where Backlog.md keeps it and what its front matter
// says, read from git objects. The engine asks for these through the StoryStore (`fileAt`,
// `statusIn`), never by the layout itself.

import type { GitSession } from "../git/office";

import { isTaskFileOf, TASKS_DIR } from "./runner";

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

/** Pure: the `status:` of a task file's front matter, or null when it has none. */
export function taskFileStatus(text: string): string | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front === null) return null;
  const line = /^status:[ \t]*(.+?)[ \t]*\r?$/m.exec(front[1] ?? "");
  const value = line?.[1]?.replace(/^(["'])(.*)\1$/, "$2").trim() ?? "";
  return value === "" ? null : value;
}
