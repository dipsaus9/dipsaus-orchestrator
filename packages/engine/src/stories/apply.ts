// One index pass applied to the state database (0005 section 2, 0007 sections 4 and 6 step 3).
// It runs inside the caller's write transaction, so every change of a pass commits together.
//
// Identity: a story whose id is a current id keeps that key unless its identity no longer matches
// (a different frozen branch, or else a different created date; a title change alone never
// counts). The keys left over have vanished. A vanished key is matched to a new id by its frozen
// branch, then by its created date. A created date shared by more than one vanished story or more
// than one new id is ambiguous: the pass reports `story.ambiguous` with an `engine.notice` and
// matches none of them. A match renumbers the key (`story.renumbered`, detected by reconcile); a
// key left unmatched is closed as `Removed` with an `engine.notice`, and an id nobody matched
// gets a new key.

import {
  type IdSource,
  type Lifecycle,
  StoryId,
  StoryKey,
  type StoryView,
} from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { deriveStoryView, isUnknownStatus, lifecycleOf, storyView } from "../views/story";

import { addStory, removeStory, renumberStories, type StoryMove } from "./keys";
import type { BacklogStory } from "./read";

/** Where a pass read Backlog.md: the `_base` worktree, or a story branch once claims read there. */
export type MirrorSource = "base" | (string & {});

export interface ApplyOptions {
  readonly at: number;
  readonly source: MirrorSource;
}

/** What one pass changed. */
export interface IndexStats {
  /** Active stories after the pass. */
  readonly stories: number;
  readonly added: number;
  readonly renumbered: number;
  readonly removed: number;
  /** Stories whose view changed (status, title, tier or id), new ones included. */
  readonly changed: number;
  /** Created dates the fallback could not resolve. */
  readonly ambiguous: number;
}

export interface ApplyResult {
  readonly stats: IndexStats;
  /** The change-log entries of the pass, in order; the caller appends them. */
  readonly entries: NewEntry[];
}

interface KnownRow {
  key: string;
  story_id: string;
  provisional: number;
  frozen_branch: string | null;
  backlog_created: string | null;
}

interface Known {
  readonly key: StoryKey;
  readonly story: StoryId;
  /** A provisional draft id (`DRAFT-n`) when the key was last seen. */
  readonly provisional: boolean;
  readonly frozenBranch: string | null;
  readonly created: string | null;
}

interface MirrorRow {
  status: string;
}

/** Both sides know the value and it differs. */
function differs(known: string | null, read: string | undefined): boolean {
  return known !== null && read !== undefined && known !== read;
}

/**
 * The story under a known id is still that story: its frozen branch matches when both have one,
 * else its created date matches when both have one. A title change alone is an edit.
 */
function sameIdentity(known: Known, read: BacklogStory): boolean {
  if (known.frozenBranch !== null && read.frozenBranch !== undefined) {
    return known.frozenBranch === read.frozenBranch;
  }
  return !differs(known.created, read.created);
}

/** Two frozen branches that are both known and differ name two stories. */
function compatible(known: Known, read: BacklogStory): boolean {
  return !differs(known.frozenBranch, read.frozenBranch);
}

function lifecycleOfRead(read: BacklogStory): Lifecycle {
  return lifecycleOf(read.kind, read.status);
}

function sameView(a: StoryView, b: StoryView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stateEntry(view: StoryView, from: Lifecycle): NewEntry {
  return {
    type: "story.state",
    key: view.key,
    delta: { story: view.story, key: view.key, from, to: view.lifecycle },
    view,
  };
}

function notice(level: "info" | "warn", code: string, text: string, key?: StoryKey): NewEntry {
  return {
    type: "engine.notice",
    ...(key === undefined ? {} : { key }),
    delta: { level, code, text },
  };
}

function byStoryId<T extends { readonly story: string }>(a: T, b: T): number {
  return a.story < b.story ? -1 : a.story > b.story ? 1 : 0;
}

/**
 * Matches what a pass read against the office's story keys and writes the result: keys, aliases,
 * removals and the `backlog_mirror` rows. Returns the change-log entries to append in the same
 * transaction. Must run inside the caller's write transaction.
 */
export function applyIndex(
  office: OfficeHandle,
  ids: IdSource,
  read: readonly BacklogStory[],
  options: ApplyOptions,
): ApplyResult {
  const { at } = options;
  const known: Known[] = office
    .all<KnownRow>(
      "select key, story_id, provisional, frozen_branch, backlog_created from stories where office_id = $office_id and removed_at is null order by story_id",
    )
    .map((row) => ({
      key: StoryKey.parse(row.key),
      story: StoryId.parse(row.story_id),
      provisional: row.provisional === 1,
      frozenBranch: row.frozen_branch,
      created: row.backlog_created,
    }));
  const before = new Map<StoryKey, StoryView>();
  const statusBefore = new Map<StoryKey, string>();
  for (const k of known) {
    const mirror = office.get<MirrorRow>(
      "select status from backlog_mirror where office_id = $office_id and key = $key",
      { key: k.key },
    );
    // A key no pass has mirrored yet has no prior view (its derived view would say Removed).
    if (mirror === null) continue;
    statusBefore.set(k.key, mirror.status);
    const view = storyView(office, k.key);
    if (view !== null) before.set(k.key, view);
  }

  // 1. Known ids whose identity still matches keep their key.
  const byId = new Map(known.map((k) => [k.story as string, k]));
  const matched = new Map<StoryKey, BacklogStory>();
  const unmatched: BacklogStory[] = [];
  const reused = new Map<StoryKey, BacklogStory>();
  for (const story of read) {
    const k = byId.get(story.story);
    if (k !== undefined && sameIdentity(k, story)) {
      matched.set(k.key, story);
    } else {
      if (k !== undefined) reused.set(k.key, story);
      unmatched.push(story);
    }
  }
  let vanished = known.filter((k) => !matched.has(k.key));

  const moves: StoryMove[] = [];
  const entries: NewEntry[] = [];
  const take = (k: Known, story: BacklogStory) => {
    matched.set(k.key, story);
    moves.push({ key: k.key, from: k.story, to: story.story });
    unmatched.splice(unmatched.indexOf(story), 1);
    vanished = vanished.filter((v) => v.key !== k.key);
  };

  // 2. Vanished keys matched by frozen branch.
  for (const k of vanished) {
    if (k.frozenBranch === null) continue;
    const candidates = unmatched.filter((s) => s.frozenBranch === k.frozenBranch);
    const rivals = vanished.filter((v) => v.frozenBranch === k.frozenBranch);
    const [only] = candidates;
    if (candidates.length === 1 && rivals.length === 1 && only !== undefined) take(k, only);
  }

  // 3. Then by created date; a date shared on either side is ambiguous and matches nothing.
  let ambiguous = 0;
  const dates = [
    ...new Set(vanished.map((k) => k.created).filter((d): d is string => d !== null)),
  ].toSorted();
  for (const date of dates) {
    const keys = vanished.filter(
      (k) => k.created === date && unmatched.some((s) => s.created === date && compatible(k, s)),
    );
    const stories = unmatched.filter(
      (s) => s.created === date && keys.some((k) => compatible(k, s)),
    );
    const [onlyKey] = keys;
    const [onlyStory] = stories;
    if (keys.length === 0 || stories.length === 0) continue;
    if (keys.length === 1 && stories.length === 1 && onlyKey !== undefined && onlyStory) {
      take(onlyKey, onlyStory);
      continue;
    }
    ambiguous += 1;
    const formerIds = keys.map((k) => k.story).join(", ");
    const newIds = stories
      .map((s) => s.story)
      .toSorted()
      .join(", ");
    entries.push(
      notice(
        "warn",
        "story.ambiguous",
        `Stories ${formerIds} vanished and ${newIds} appeared, all created ${date}, so dipo cannot tell which is which; it matched none of them. The vanished stories are closed as Removed and the new ids get new keys.`,
      ),
    );
  }

  // 4. Keys left over are closed as Removed.
  for (const k of vanished) {
    removeStory(office, k.key, at);
    const view = storyView(office, k.key);
    // Without a prior view the stories row tells: a provisional draft id was a Draft, else Refined.
    const from = before.get(k.key)?.lifecycle ?? (k.provisional ? "Draft" : "Refined");
    if (view !== null) entries.push(stateEntry(view, from));
    const reuse = reused.get(k.key);
    entries.push(
      notice(
        "warn",
        "story.removed",
        reuse === undefined
          ? `${k.story} is no longer an active task or draft (archived, completed or deleted); dipo closed its story as Removed.`
          : `${k.story} now names another story (its frozen branch or created date changed); dipo closed the old story as Removed and gave the story now under ${k.story} a new key.`,
        k.key,
      ),
    );
  }

  // 5. Renumberings, then the frozen branch and created date of every matched key.
  renumberStories(office, moves, at);
  for (const move of moves.toSorted(byStoryIdOf)) {
    entries.push({
      type: "story.renumbered",
      key: move.key,
      delta: { key: move.key, from: move.from, to: move.to, detectedBy: "reconcile" },
    });
  }
  for (const [key, story] of matched) {
    office.run(
      `update stories set
         frozen_branch = coalesce(frozen_branch, $branch),
         backlog_created = coalesce(backlog_created, $created)
       where office_id = $office_id and key = $key`,
      { key, branch: story.frozenBranch ?? null, created: story.created ?? null },
    );
  }

  // 6. New keys for ids nobody matched.
  const added = new Set<StoryKey>();
  for (const story of unmatched) {
    const identity = addStory(
      office,
      ids,
      {
        story: story.story,
        ...(story.frozenBranch === undefined ? {} : { frozenBranch: story.frozenBranch }),
        ...(story.created === undefined ? {} : { backlogCreated: story.created }),
      },
      at,
    );
    matched.set(identity.key, story);
    added.add(identity.key);
  }

  // 7. The mirror, and a `story.state` for every story whose view changed.
  const changes: { view: StoryView; from: Lifecycle }[] = [];
  for (const [key, story] of matched) {
    office.run(
      `insert into backlog_mirror
         (office_id, key, content_hash, kind, status, title, tier, role, labels, read_at, source)
       values ($office_id, $key, $hash, $kind, $status, $title, $tier, $role, $labels, $at, $source)
       on conflict (office_id, key) do update set
         content_hash = excluded.content_hash, kind = excluded.kind, status = excluded.status,
         title = excluded.title, tier = excluded.tier, role = excluded.role,
         labels = excluded.labels, read_at = excluded.read_at, source = excluded.source`,
      {
        key,
        hash: story.contentHash,
        kind: story.kind,
        status: story.status,
        title: story.title,
        tier: story.tier ?? null,
        role: story.role ?? null,
        labels: JSON.stringify(story.labels),
        at,
        source: options.source,
      },
    );
    const view = deriveStoryView({
      key,
      story: story.story,
      title: story.title,
      lifecycle: lifecycleOfRead(story),
      ...(story.tier === undefined ? {} : { tier: story.tier }),
    });
    const previous = before.get(key);
    if (previous === undefined || !sameView(previous, view)) {
      changes.push({ view, from: previous?.lifecycle ?? view.lifecycle });
    }
    if (isUnknownStatus(story.kind, story.status) && statusBefore.get(key) !== story.status) {
      entries.push(
        notice(
          "info",
          "story.statusUnknown",
          `${story.story} has the status "${story.status}", which is not a dipo status; dipo shows it as Refined.`,
          key,
        ),
      );
    }
  }
  for (const { view, from } of changes.toSorted((a, b) => byStoryId(a.view, b.view))) {
    entries.push(stateEntry(view, from));
  }

  return {
    stats: {
      stories: matched.size,
      added: added.size,
      renumbered: moves.length,
      removed: vanished.length,
      changed: changes.length,
      ambiguous,
    },
    entries,
  };
}

function byStoryIdOf(a: StoryMove, b: StoryMove): number {
  return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
}
