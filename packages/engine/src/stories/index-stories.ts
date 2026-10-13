// `indexStories` (0007 section 6 step 3, 0010 section 2): one pass over the office's stories. It
// brings the `_base` worktree to `origin/<base>` if it is missing, then, as one item in the office
// git queue so no fetch moves `_base` meanwhile, reads every task and draft there through the
// Backlog CLI and writes every change of the pass, with its change-log entries, in one transaction.

import type { Clock, Cursor, IdSource } from "@dipsaus-orchestrator/contract";

import type { BacklogCli } from "../backlog/runner";
import { appendEntries } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import type { OfficeGit } from "../git/office";

import { applyIndex, type IndexStats } from "./apply";
import { readBacklog } from "./read";

export interface IndexDeps {
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly cli: BacklogCli;
  readonly clock: Clock;
  readonly ids: IdSource;
}

export interface IndexResult {
  readonly stats: IndexStats;
  /** The `_base` commit the pass read. */
  readonly sha: string;
  /** The last change-log entry the pass wrote; undefined when nothing changed. */
  readonly cursor: Cursor | undefined;
}

/**
 * Indexes the office's stories from `_base`. Throws `GitError` when the office has no base or
 * `origin/<base>` is missing, and the Backlog CLI errors of `readBacklog`; nothing is written then.
 */
export async function indexStories(deps: IndexDeps): Promise<IndexResult> {
  const base = await deps.git.ensureBaseWorktree();
  return deps.git.run(async (git) => {
    // A fetch queued before this item may have moved `_base` since it was ensured.
    const location = deps.git.worktreeLocation(base.path);
    const sha = (await git.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
    const read = await readBacklog(deps.cli, base.path);
    const at = deps.clock.now();
    return deps.office.immediate(() => {
      const { stats, entries } = applyIndex(deps.office, deps.ids, read, { at, source: "base" });
      const cursor = appendEntries(deps.office, entries, { at });
      return { stats, sha, cursor };
    });
  });
}
