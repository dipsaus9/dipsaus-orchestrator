// `indexStories` (0007 section 6 step 3, 0010 section 2): one pass over the office's stories. It
// brings the `_base` worktree to `origin/<base>` if it is missing, then, as one item in the office
// git queue so no fetch moves `_base` meanwhile, reads every task and draft there through the
// StoryStore and writes every change of the pass, with its change-log entries, in one transaction.
//
// A claimed story is read on its story branch (DIPO-56, 0007 section 6 step 3; 0010 section 2a):
// from the claim commit until the claim is released, its status, park record (F16), criteria and
// tier live there, so the pass reads it again as committed at the branch tip (the store's
// `readOnBranch`; never a worktree's uncommitted edits) and mirrors that read with the branch as `source`. A
// claimed story whose branch cannot be read (the ref or its task file missing) is listed in
// `branchUnread`, and its mirror row keeps the last read of the branch (DIPO-360), so its status
// and park do not fall back to the base's; the pass emits one `stories.branchUnread` notice until
// the branch reads again, and reconcile reports it.
// `refreshStory` reads one story the same way, right after a commit on its branch.
//
// With `reuseViews` the store does not read a story again in a pass when nothing it printed changed
// since the office's last read (DIPO-314, `ReadReuse`): the Backlog.md store lists the blobs of the
// base's Backlog files with `git ls-tree` in the same queue item. Without that list (a failed
// `ls-tree`), or without `reuseViews`, every story is read.

import type { Clock, Cursor, IdSource, StoryKey } from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import type { GitSession, OfficeGit } from "../git/office";
import { findStoryByKey, isProvisionalId } from "../records/story-keys";
import type { StoryStore } from "../story-store/store";
import { type ClaimRecord, liveClaimOf, liveClaims } from "../worktree/records";

import { applyIndex, applyStory, type IndexStats } from "./apply";
import { type BacklogStory, storyFromRead } from "./read";

export interface IndexDeps {
  readonly office: OfficeHandle;
  readonly git: OfficeGit;
  readonly stories: StoryStore;
  readonly clock: Clock;
  readonly ids: IdSource;
  /**
   * Takes a story from the store's kept reads of the office when nothing it printed changed
   * (DIPO-314); every story is read without it.
   */
  readonly reuseViews?: boolean;
}

/** A claimed story the pass could not read on its branch; its base read was used. */
export interface BranchUnread {
  readonly key: StoryKey;
  readonly story: string;
  readonly branch: string;
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
 * when the office has no base or `origin/<base>` is missing, and the `StoryStoreError` of a failed
 * read; nothing is written then.
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
  const reuse =
    deps.reuseViews === true ? { key: deps.office, session: git, location, sha } : undefined;
  const fromBase = (await deps.stories.readAll(basePath, reuse)).map(storyFromRead);
  const { read, branchUnread, baseStatus } = await overlayClaimed(deps, git, basePath, fromBase);
  const at = deps.clock.now();
  return deps.office.immediate(() => {
    const keepMirror = new Set(branchUnread.map((unread) => unread.key));
    const { stats, entries } = applyIndex(deps.office, deps.ids, read, {
      at,
      source: "base",
      sha,
      keepMirror,
    });
    entries.push(...branchUnreadNotices(deps.office, branchUnread, at));
    const cursor = appendEntries(deps.office, entries, { at });
    return { stats, sha, cursor, read, branchUnread, baseStatus };
  });
}

/** The notice code of a claimed story whose branch could not be read (DIPO-360). */
export const BRANCH_UNREAD_NOTICE = "stories.branchUnread";

/** The `once_notices` code of a claimed story whose branch could not be read (DIPO-360). */
function unreadCode(key: string): string {
  return `${BRANCH_UNREAD_NOTICE}:${key}`;
}

/**
 * Inside the pass's transaction (DIPO-360): one warn notice when a claimed story's branch first
 * cannot be read, saying its last read is kept; cleared once the branch reads again, so the next
 * time it cannot be read gets a notice again.
 */
function branchUnreadNotices(
  office: IndexDeps["office"],
  unread: readonly BranchUnread[],
  at: number,
): NewEntry[] {
  // A branch that reads again, or a claim released, clears its mark.
  const marked = new Set(unread.map((u) => unreadCode(u.key)));
  for (const { code } of office.all<{ code: string }>(
    "select code from once_notices where office_id = $office_id and code like $prefix",
    { prefix: `${BRANCH_UNREAD_NOTICE}:%` },
  )) {
    if (marked.has(code)) continue;
    office.run("delete from once_notices where office_id = $office_id and code = $code", { code });
  }
  const entries: NewEntry[] = [];
  for (const u of unread) {
    const first = office.run(
      `insert into once_notices (office_id, code, shown_at)
       values ($office_id, $code, $at) on conflict do nothing`,
      { code: unreadCode(u.key), at },
    );
    if (first.changes === 0) continue;
    entries.push({
      type: "engine.notice",
      key: u.key,
      delta: {
        level: "warn",
        code: BRANCH_UNREAD_NOTICE,
        text: `dipo could not read ${u.story} on its branch ${u.branch} (${u.reason}); it keeps the story's last read, its status and park included, until the branch reads again.`,
      },
    });
  }
  return entries;
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
      const onBranch = await deps.stories.readOnBranch(deps.git, session, claim, basePath, {
        id,
        title: listed.title,
        status: listed.status,
      });
      // The gate reads every task as it is on `_base`, not as the claimed story's branch has it.
      read[index] = {
        ...storyFromRead(onBranch),
        source: claim.branch,
        ...(listed.gateTask === undefined ? {} : { gateTask: listed.gateTask }),
      };
      baseStatus.set(claim.key, listed.status);
    } catch (error) {
      branchUnread.push({
        key: claim.key,
        story: id,
        branch: claim.branch,
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
    if (onBranch) {
      const read = await deps.stories.readOnBranch(deps.git, session, claim, base.path, listed);
      return { ...storyFromRead(read), source: claim.branch };
    }
    return storyFromRead(await deps.stories.read(base.path, kind, listed));
  });
  const at = deps.clock.now();
  return deps.office.immediate(() => {
    const entries = applyStory(deps.office, key, story, { at, source: "base", ...options });
    return appendEntries(deps.office, entries, { at });
  });
}
