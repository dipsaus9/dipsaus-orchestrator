// A commit's tree read from git objects alone (`git ls-tree -r`), with no checkout.

import type { GitSession } from "./office";

/** One entry of a tree (`git ls-tree -r`). */
export interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly id: string;
}

/** Pure: the entries of `git ls-tree -r -z` output, by path. */
export function parseTree(listed: string): Map<string, GitTreeEntry> {
  const entries = new Map<string, GitTreeEntry>();
  for (const line of listed.split("\0")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    const [mode = "", type = "", id = ""] = line.slice(0, tab).split(" ");
    entries.set(line.slice(tab + 1), { mode, type, id });
  }
  return entries;
}

/** Every entry of the tree of `commit`, by path. */
export async function listTree(
  session: GitSession,
  commit: string,
): Promise<Map<string, GitTreeEntry>> {
  return parseTree(await session.ok(session.repository, ["ls-tree", "-r", "-z", commit]));
}
