// `indexStories` (0007 section 6 step 3, 0010 section 2): one pass over the office's stories. It
// brings the `_base` worktree to `origin/<base>` if it is missing, then, as one item in the office
// git queue so no fetch moves `_base` meanwhile, reads every task and draft there through the
// Backlog CLI and writes every change of the pass, with its change-log entries, in one transaction.
//
// A claimed story is read on its story branch (DIPO-56, 0007 section 6 step 3; 0010 section 2a):
// from the claim commit until the claim is released, its status, park record (F16), criteria and
// tier live there, so the pass reads it again as committed at the branch tip (`branch-read.ts`;
// never the worktree's uncommitted edits) and mirrors that read with the branch as `source`. A
// claimed story whose branch cannot be read (the ref or its task file missing) keeps its base
// read and is listed in `branchUnread`; reconcile reports it.
// `refreshStory` reads one story the same way, right after a commit on its branch.

import type { Clock, Cursor, IdSource, StoryKey } from "@dipsaus-orchestrator/contract";

import type { BacklogCli } from "../backlog/runner";
import { appendEntries } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import type { GitSession, OfficeGit } from "../git/office";
import { type ClaimRecord, liveClaimOf, liveClaims } from "../worktree/records";

import { applyIndex, applyStory, type IndexStats } from "./apply";
import { readOnBranch } from "./branch-read";
import { findStoryByKey, isProvisionalId } from "./keys";
import { type BacklogStory, readBacklog, readStory } from "./read";

export interface IndexDeps {
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly cli: BacklogCli;
  readonly clock: Clock;
  readonly ids: IdSource;
}

/** A claimed story the pass could not read on its branch; its base read was used. */
export interface BranchUnread {
  readonly key: StoryKey;
  readonly story: string;
  readonly branch: string;
  readonly worktree: string;
  readonly reason: string;
}

export interface IndexResult {
  readonly stats: IndexStats;
  /** The `_base` commit the pass read. */
  readonly sha: string;
  /** The last change-log entry the pass wrote; undefined when nothing changed. */
  readonly cursor: Cursor | undefined;
  /** What the pass read, claimed stories as read on their branch (`source`). */
  readonly read: readonly BacklogStory[];
  /** Claimed stories whose branch could not be read. */
  readonly branchUnread: readonly BranchUnread[];
  /**
   * The status each claimed story read on its branch has on `_base`, by story key (DIPO-216):
   * `read` holds the branch's status, reconcile needs this one to see a story Done on the base.
   */
  readonly baseStatus: ReadonlyMap<StoryKey, string>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True while the claim's branch holds the story (0010 section 2a): from its claim commit until
 * its release or teardown. A claim whose setup never finished has no claim commit yet.
 */
export function readsOnBranch(claim: ClaimRecord): boolean {
  return claim.claimSha !== null && claim.releasedAt === null && claim.teardownStartedAt === null;
}

/**
 * Indexes the office's stories from `_base`, claimed ones from their branch. Throws `GitError`
 * when the office has no base or `origin/<base>` is missing, and the Backlog CLI errors of
 * `readBacklog`; nothing is written then.
 */
export async function indexStories(deps: IndexDeps): Promise<IndexResult> {
  const base = await deps.git.ensureBaseWorktree();
  return deps.git.run((git) => indexPass(deps, git, base.path));
}

/**
 * The pass itself, for a caller that already holds the office's git queue item with `git` (the
 * Ready gate bringing the mirror up to the commit it reads, DIPO-180). Besides each story's view it
 * stores the dependencies and branch of every task with the commit, for the gate.
 */
export async function indexPass(
  deps: IndexDeps,
  git: GitSession,
  basePath: string,
): Promise<IndexResult> {
  // A fetch queued before this item may have moved `_base` since it was ensured.
  const location = deps.git.worktreeLocation(basePath);
  const sha = (await git.ok(location, ["rev-parse", "--verify", "HEAD"])).trim();
  const fromBase = await readBacklog(deps.cli, basePath);
  const { read, branchUnread, baseStatus } = await overlayClaimed(deps, git, basePath, fromBase);
  const at = deps.clock.now();
  return deps.office.immediate(() => {
    const { stats, entries } = applyIndex(deps.office, deps.ids, read, {
      at,
      source: "base",
      sha,
    });
    const cursor = appendEntries(deps.office, entries, { at });
    return { stats, sha, cursor, read, branchUnread, baseStatus };
  });
}

/** The base read with every claimed story replaced by its read on the story branch. */
async function overlayClaimed(
  deps: IndexDeps,
  session: GitSession,
  basePath: string,
  fromBase: readonly BacklogStory[],
): Promise<{
  read: BacklogStory[];
  branchUnread: BranchUnread[];
  baseStatus: Map<StoryKey, string>;
}> {
  const read = [...fromBase];
  const branchUnread: BranchUnread[] = [];
  const baseStatus = new Map<StoryKey, string>();
  for (const claim of liveClaims(deps.office)) {
    if (!readsOnBranch(claim)) continue;
    // The story's id as the engine knows it now; a story renumbered by hand meanwhile is matched
    // by the pass and read on its branch from the next pass on.
    const id = findStoryByKey(deps.office, claim.key)?.story ?? claim.story;
    const index = read.findIndex((story) => story.story === id && story.kind === "task");
    const listed = read[index];
    if (listed === undefined || isProvisionalId(id)) continue;
    try {
      const onBranch = await readOnBranch(deps.git, session, deps.cli, claim, basePath, {
        id,
        title: listed.title,
        status: listed.status,
      });
      // The gate reads every task as it is on `_base`, not as the claimed story's branch has it.
      read[index] = {
        ...onBranch,
        ...(listed.gateTask === undefined ? {} : { gateTask: listed.gateTask }),
      };
      baseStatus.set(claim.key, listed.status);
    } catch (error) {
      branchUnread.push({
        key: claim.key,
        story: id,
        branch: claim.branch,
        worktree: claim.worktree,
        reason: messageOf(error),
      });
    }
  }
  return { read, branchUnread, baseStatus };
}

export interface RefreshOptions {
  /** True when the caller already emitted the story's new state (a park). */
  readonly quiet?: boolean;
}

/**
 * Reads one story again (DIPO-56): on its branch while it is claimed, else on `_base`, and writes
 * its mirror row, with a `story.state` when its view changed. Returns the cursor of the entry it
 * wrote, or undefined. Throws when the story is unknown or cannot be read.
 */
export async function refreshStory(
  deps: IndexDeps,
  key: StoryKey,
  options: RefreshOptions = {},
): Promise<Cursor | undefined> {
  const identity = findStoryByKey(deps.office, key);
  if (identity === null) throw new Error(`No story has the key ${key}.`);
  const kind = isProvisionalId(identity.story) ? "draft" : "task";
  const claim = liveClaimOf(deps.office, key);
  const onBranch = claim !== null && readsOnBranch(claim);
  const base = await deps.git.ensureBaseWorktree();
  const story = await deps.git.run(async (session) => {
    const listed = { id: identity.story as string, title: "", status: "" };
    if (onBranch) return readOnBranch(deps.git, session, deps.cli, claim, base.path, listed);
    return readStory(deps.cli, base.path, kind, listed);
  });
  const at = deps.clock.now();
  return deps.office.immediate(() => {
    const entries = applyStory(deps.office, key, story, { at, source: "base", ...options });
    return appendEntries(deps.office, entries, { at });
  });
}
