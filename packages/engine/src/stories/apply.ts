// One index pass applied to the state database (0005, 0007).
// It runs inside the caller's write transaction, so every change of a pass commits together.
//
// Identity (0005, 0007): a story whose id is a current id keeps its key. A key whose id vanished
// is closed as `Removed` with an `engine.notice`, and an id no key has gets a new key: a new id
// is a new story. Nothing is matched by branch, date or title. The one exception is a draft dipo
// promoted itself (a triage refine, DIPO-454): its key holds the new id as `promoted_to`, so when
// its draft id vanished and that id appears, the key is renumbered to it (`story.renumbered`).

import {
  type IdSource,
  type Lifecycle,
  StoryId,
  StoryKey,
  type StoryView,
} from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { draftOrigins } from "../records/ideas";
import { READY_STATUS } from "../records/select";
import { addStory, removeStory, renumberStory } from "../records/story-keys";
import { isUnknownStatus, storyView, workByKey } from "../views/story";

import type { BacklogStory } from "./read";

/** Where a pass read Backlog.md: the `_base` worktree, or a story branch once claims read there. */
export type MirrorSource = "base" | (string & {});

export interface ApplyOptions {
  readonly at: number;
  readonly source: MirrorSource;
  /**
   * The `_base` commit a pass read (DIPO-180): the dependencies and branch of each task are stored
   * with it for the Ready gate. Absent for a read of one story, which leaves them as they are.
   */
  readonly sha?: string;
  /**
   * Claimed stories whose branch could not be read (DIPO-360): their mirror row, when they have
   * one, keeps the last read of the branch instead of the base read, so an unreadable branch does
   * not make the story's status or park disappear.
   */
  readonly keepMirror?: ReadonlySet<StoryKey>;
}

/** What one pass changed. */
export interface IndexStats {
  /** Active stories after the pass. */
  readonly stories: number;
  readonly added: number;
  readonly removed: number;
  /** Stories whose view changed (status, title, tier or id), new ones included. */
  readonly changed: number;
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
  promoted_to: string | null;
}

interface Known {
  readonly key: StoryKey;
  readonly story: StoryId;
  /** A provisional draft id (`DRAFT-n`) when the key was last seen. */
  readonly provisional: boolean;
  /** The task id dipo promoted this draft to (DIPO-454), until the index sees it. */
  readonly promotedTo: string | null;
}

interface MirrorRow {
  status: string;
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
 * Matches what a pass read against the office's story keys and writes the result: keys, removals
 * and the `backlog_mirror` rows. Returns the change-log entries to append in the same
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
      "select key, story_id, provisional, promoted_to from stories where office_id = $office_id and removed_at is null order by story_id",
    )
    .map((row) => ({
      key: StoryKey.parse(row.key),
      story: StoryId.parse(row.story_id),
      provisional: row.provisional === 1,
      promotedTo: row.promoted_to,
    }));
  // Who works on which story does not change during a pass: derived once (DIPO-52).
  const work = workByKey(office);
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
    const view = storyView(office, k.key, work);
    if (view !== null) before.set(k.key, view);
  }

  // 1. A known id keeps its key; the keys left over have vanished.
  const byId = new Map(known.map((k) => [k.story as string, k]));
  const matched = new Map<StoryKey, BacklogStory>();
  const unmatched: BacklogStory[] = [];
  for (const story of read) {
    const k = byId.get(story.story);
    if (k === undefined) unmatched.push(story);
    else matched.set(k.key, story);
  }
  const entries: NewEntry[] = [];

  // 2. A draft dipo promoted (DIPO-454) whose draft id vanished and whose new id appeared keeps its
  //    key under the new id.
  for (const k of known) {
    if (k.promotedTo === null || matched.has(k.key)) continue;
    const index = unmatched.findIndex((story) => story.story === k.promotedTo);
    const promoted = unmatched[index];
    if (promoted === undefined) continue;
    unmatched.splice(index, 1);
    const { from, to } = renumberStory(office, k.key, promoted.story, at);
    office.run(
      "update stories set promoted_to = null where office_id = $office_id and key = $key",
      {
        key: k.key,
      },
    );
    matched.set(k.key, promoted);
    entries.push({
      type: "story.renumbered",
      key: k.key,
      delta: { key: k.key, from, to, detectedBy: "engine" },
    });
  }
  const vanished = known.filter((k) => !matched.has(k.key));

  // 3. Vanished keys are closed as Removed.
  for (const k of vanished) {
    removeStory(office, k.key, at);
    const view = storyView(office, k.key, work);
    // Without a prior view the stories row tells: a provisional draft id was a Draft, else Refined.
    const from = before.get(k.key)?.lifecycle ?? (k.provisional ? "Draft" : "Refined");
    if (view !== null) entries.push(stateEntry(view, from));
    entries.push(
      notice(
        "warn",
        "story.removed",
        `${k.story} is no longer an active task or draft (archived, completed, deleted or renamed); dipo closed its story as Removed.`,
        k.key,
      ),
    );
  }

  // 4. The frozen branch of every known key, once the story has one.
  for (const [key, story] of matched) {
    office.run(
      `update stories set frozen_branch = coalesce(frozen_branch, $branch)
       where office_id = $office_id and key = $key`,
      { key, branch: story.frozenBranch ?? null },
    );
  }

  // 5. New keys for new ids, each with where it came from (DIPO-453).
  const added = new Set<StoryKey>();
  let drafts: ReturnType<typeof draftOrigins> | null = null;
  const origins = () => (drafts ??= draftOrigins(office));
  for (const story of unmatched) {
    const identity = addStory(
      office,
      ids,
      {
        story: story.story,
        ...(story.frozenBranch === undefined ? {} : { frozenBranch: story.frozenBranch }),
      },
      at,
    );
    matched.set(identity.key, story);
    added.add(identity.key);
    recordOrigin(office, identity.key, story, origins());
  }

  // 6. The mirror, and a `story.state` for every story whose view changed.
  const changes: { view: StoryView; from: Lifecycle }[] = [];
  for (const [key, story] of matched) {
    if (!(options.keepMirror?.has(key) === true && statusBefore.has(key))) {
      writeMirror(office, key, story, at, story.source ?? options.source, options.sha);
    }
    const view = storyView(office, key, work);
    if (view === null) continue;
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
      removed: vanished.length,
      changed: changes.length,
    },
    entries,
  };
}

/** The idea origins a story's origin column keeps; the column's check lists them. */
const IDEA_ORIGINS_KEPT: ReadonlySet<string> = new Set(["proposal", "finding", "aside", "quick"]);

const sameTitle = (a: string, b: string) =>
  a.toLowerCase().replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Records where a story first seen came from (DIPO-453, 0022): the origin of the idea whose
 * accepted draft it is (same id and title), `planned` when a planning session filed it, else
 * nothing, which retro shows as unknown.
 */
function recordOrigin(
  office: OfficeHandle,
  key: StoryKey,
  story: BacklogStory,
  drafts: ReturnType<typeof draftOrigins>,
): void {
  const draft = drafts.get(story.story.toUpperCase());
  let origin: string | null = null;
  if (draft !== undefined && sameTitle(draft.title, story.title)) {
    origin = IDEA_ORIGINS_KEPT.has(draft.origin) ? draft.origin : null;
  } else if (
    office.get(
      `select 1 as found from planning_records
        where office_id = $office_id and kind = 'story' and subject = $story and text = 'filed'`,
      { story: story.story },
    ) !== null
  ) {
    origin = "planned";
  }
  if (origin === null) return;
  office.run("update stories set origin = $origin where office_id = $office_id and key = $key", {
    key,
    origin,
  });
}

/**
 * Writes the `backlog_mirror` row of `key` from what was read. A park record keeps the time it
 * was first seen while it stays the same (DIPO-52). With `gateSha` and a `gateTask` on the story
 * it also stores what the Ready gate reads of the task, as of that commit (DIPO-180); otherwise
 * those columns stay as they are. Runs inside the caller's transaction.
 */
export function writeMirror(
  office: OfficeHandle,
  key: StoryKey,
  story: BacklogStory,
  at: number,
  source: MirrorSource,
  gateSha?: string,
): void {
  const gate = gateSha === undefined ? undefined : story.gateTask;
  office.run(
    `insert into backlog_mirror
       (office_id, key, content_hash, kind, status, title, tier, role, labels, read_at, source,
        waiting_on, park, park_since, criteria_met, criteria_total, criteria_numbers,
        gate_sha, gate_dependencies, gate_branch)
     values ($office_id, $key, $hash, $kind, $status, $title, $tier, $role, $labels, $at, $source,
        $waiting_on, $park, $park_since, $criteria_met, $criteria_total, $criteria_numbers,
        $gate_sha, $gate_dependencies, $gate_branch)
     on conflict (office_id, key) do update set
       content_hash = excluded.content_hash, kind = excluded.kind, status = excluded.status,
       title = excluded.title, tier = excluded.tier, role = excluded.role,
       labels = excluded.labels, read_at = excluded.read_at, source = excluded.source,
       waiting_on = excluded.waiting_on,
       park_since = case when excluded.park is null then null
         when backlog_mirror.park is excluded.park then backlog_mirror.park_since
         else excluded.park_since end,
       park = excluded.park,
       criteria_met = excluded.criteria_met, criteria_total = excluded.criteria_total,
       criteria_numbers = excluded.criteria_numbers,
       gate_dependencies = case when excluded.gate_sha is null then backlog_mirror.gate_dependencies
         else excluded.gate_dependencies end,
       gate_branch = case when excluded.gate_sha is null then backlog_mirror.gate_branch
         else excluded.gate_branch end,
       gate_sha = coalesce(excluded.gate_sha, backlog_mirror.gate_sha)`,
    {
      gate_sha: gate === undefined ? null : (gateSha ?? null),
      gate_dependencies: gate === undefined ? null : JSON.stringify(gate.dependencies),
      gate_branch: gate?.branch ?? null,
      key,
      hash: story.contentHash,
      kind: story.kind,
      status: story.status,
      title: story.title,
      tier: story.tier ?? null,
      role: story.role ?? null,
      labels: JSON.stringify(story.labels),
      at,
      source,
      waiting_on:
        story.waitingOn === undefined || story.waitingOn.length === 0
          ? null
          : JSON.stringify(story.waitingOn),
      park: story.park === undefined ? null : JSON.stringify(story.park),
      park_since: story.park === undefined ? null : at,
      criteria_met: story.criteria?.met ?? null,
      criteria_total: story.criteria?.total ?? null,
      criteria_numbers:
        story.criteria?.numbers === undefined ? null : JSON.stringify(story.criteria.numbers),
    },
  );
  // What retro needs (DIPO-453): the type, and the first time the story was read as Ready.
  office.run(
    `update stories set story_type = coalesce($type, story_type),
       ready_at = case when $ready = 1 then coalesce(ready_at, $at) else ready_at end
      where office_id = $office_id and key = $key`,
    {
      key,
      type: story.storyType ?? null,
      ready: story.kind === "task" && story.status === READY_STATUS ? 1 : 0,
      at,
    },
  );
}

/**
 * Writes one story read again on its own (DIPO-56: right after a claim or park commit on its
 * branch) to its mirror row, and returns a `story.state` when its view changed. Unlike a pass it
 * matches no identity: `key` must be the key the story was read for. With `quiet` it returns
 * nothing, for a caller that already emitted the state. Must run inside the caller's write
 * transaction.
 */
export function applyStory(
  office: OfficeHandle,
  key: StoryKey,
  story: BacklogStory,
  options: ApplyOptions & { readonly quiet?: boolean },
): NewEntry[] {
  const work = workByKey(office);
  const known = office.get<MirrorRow>(
    "select status from backlog_mirror where office_id = $office_id and key = $key",
    { key },
  );
  const previous = known === null ? null : storyView(office, key, work);
  writeMirror(office, key, story, options.at, story.source ?? options.source);
  const view = storyView(office, key, work);
  if (options.quiet === true || view === null) return [];
  if (previous !== null && sameView(previous, view)) return [];
  return [stateEntry(view, previous?.lifecycle ?? view.lifecycle)];
}
