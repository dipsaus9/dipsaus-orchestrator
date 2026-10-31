// Story identity (0005 section 2, 0007 section 4). The engine gives each story a `StoryKey` when
// it first sees it; facts, the change log and idempotency records refer to the key. A Backlog.md id
// resolves first as a current id, then through the aliases of former ids. An alias is retired as
// soon as its id becomes another story's current id, so a reused `DRAFT-n` never reaches the old
// story. All writes here run inside the caller's transaction.

import {
  engineError,
  type EngineError,
  type IdSource,
  StoryId,
  StoryKey,
} from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";

export interface StoryIdentity {
  readonly key: StoryKey;
  readonly story: StoryId;
}

export type StoryResolution =
  | { readonly ok: true; readonly key: StoryKey; readonly story: StoryId }
  | { readonly ok: false; readonly error: EngineError };

/** True for a provisional Backlog.md draft id such as `DRAFT-3` (0005 section 2). */
export function isProvisionalId(story: string): boolean {
  return /^DRAFT-\d+$/i.test(story);
}

interface StoryRow {
  key: string;
  story_id: string;
}

/** The current identity of a story by key, removed or not; null when the key is unknown. */
export function findStoryByKey(office: OfficeHandle, key: StoryKey): StoryIdentity | null {
  const row = office.get<StoryRow>(
    "select key, story_id from stories where office_id = $office_id and key = $key",
    { key },
  );
  return row === null ? null : { key: row.key as StoryKey, story: row.story_id as StoryId };
}

/**
 * Resolves a command's story reference: a key directly, an id as a current id, then through the
 * live aliases. An id that names more than one story fails with `story.ambiguous`.
 */
export function resolveStoryRef(office: OfficeHandle, ref: string): StoryResolution {
  if (StoryKey.safeParse(ref).success) {
    const found = findStoryByKey(office, ref as StoryKey);
    if (found !== null) return { ok: true, ...found };
    return {
      ok: false,
      error: engineError("story.unknown", `No story has the key ${ref}.`, { story: ref }),
    };
  }

  const current = office.all<StoryRow>(
    "select key, story_id from stories where office_id = $office_id and story_id = $story and removed_at is null",
    { story: ref },
  );
  const aliased = office.all<StoryRow>(
    `select a.key as key, s.story_id as story_id
       from story_aliases a join stories s on s.office_id = a.office_id and s.key = a.key
      where a.office_id = $office_id and a.story_id = $story and a.retired_at is null`,
    { story: ref },
  );
  const matches = new Map<string, StoryRow>();
  for (const row of [...current, ...aliased]) matches.set(row.key, row);

  const [only, ...others] = matches.values();
  if (only === undefined) {
    return {
      ok: false,
      error: engineError("story.unknown", `No story has the id ${ref}.`, { story: ref }),
    };
  }
  if (others.length > 0) {
    return {
      ok: false,
      error: engineError(
        "story.ambiguous",
        `The id ${ref} names more than one story; use its key instead.`,
        { story: ref, keys: [...matches.keys()].toSorted() },
      ),
    };
  }
  return { ok: true, key: only.key as StoryKey, story: only.story_id as StoryId };
}

/** Retires every live alias `story` of a story other than `owner` (0005 section 2). */
function retireAliases(office: OfficeHandle, story: StoryId, owner: StoryKey, at: number): void {
  office.run(
    "update story_aliases set retired_at = $at where office_id = $office_id and story_id = $story and key <> $owner and retired_at is null",
    { story, owner, at },
  );
}

export interface NewStory {
  readonly story: StoryId;
  /** The frozen branch (0012 F15), from Refined on. */
  readonly frozenBranch?: string;
  /** The created date exactly as the Backlog CLI prints it. */
  readonly backlogCreated?: string;
}

/** Records a story the engine sees for the first time and gives it a new `sto_<ulid>` key. */
export function addStory(
  office: OfficeHandle,
  ids: IdSource,
  story: NewStory,
  at: number,
): StoryIdentity {
  const key = StoryKey.parse(ids.next("sto"));
  office.run(
    `insert into stories (office_id, key, story_id, provisional, frozen_branch, backlog_created, first_seen_at)
     values ($office_id, $key, $story, $provisional, $branch, $created, $at)`,
    {
      key,
      story: story.story,
      provisional: isProvisionalId(story.story) ? 1 : 0,
      branch: story.frozenBranch ?? null,
      created: story.backlogCreated ?? null,
      at,
    },
  );
  retireAliases(office, story.story, key, at);
  return { key, story: story.story };
}

/**
 * Gives a story a new current id (draft promotion or a renumbering found by reconcile). The former
 * id becomes an alias of the story, and any other story's live alias equal to the new id retires.
 */
export function renumberStory(
  office: OfficeHandle,
  key: StoryKey,
  to: StoryId,
  at: number,
): { readonly from: StoryId; readonly to: StoryId } {
  const current = findStoryByKey(office, key);
  if (current === null) throw new Error(`Cannot renumber unknown story key ${key}.`);
  const from = current.story;
  if (from === to) return { from, to };
  applyRenumber(office, key, from, to, at);
  return { from, to };
}

export interface StoryMove {
  readonly key: StoryKey;
  readonly from: StoryId;
  readonly to: StoryId;
}

/**
 * Renumbers several stories at once, as reconcile finds them (0005 section 2). Ids may move in a
 * chain or a swap (A to B while B goes to C), so every moved story first takes its own key as a
 * placeholder id, which no Backlog.md id can equal, and then its new id.
 */
export function renumberStories(
  office: OfficeHandle,
  moves: readonly StoryMove[],
  at: number,
): void {
  const real = moves.filter((move) => move.from !== move.to);
  for (const { key } of real) {
    office.run(
      "update stories set story_id = $key where office_id = $office_id and key = $key and removed_at is null",
      { key },
    );
  }
  for (const { key, from, to } of real) applyRenumber(office, key, from, to, at);
  // A later move may have made an earlier move's new id its former id: retire that alias too.
  for (const { key, to } of real) retireAliases(office, to, key, at);
}

function applyRenumber(
  office: OfficeHandle,
  key: StoryKey,
  from: StoryId,
  to: StoryId,
  at: number,
): void {
  office.run(
    `insert into story_aliases (office_id, key, story_id, valid_from) values ($office_id, $key, $from, $at)
     on conflict (office_id, key, story_id) do update set valid_from = $at, retired_at = null`,
    { key, from, at },
  );
  office.run(
    "update stories set story_id = $to, provisional = $provisional where office_id = $office_id and key = $key",
    { key, to, provisional: isProvisionalId(to) ? 1 : 0 },
  );
  // The story's own alias for its new id, if it ever had one, is no longer a former id.
  office.run(
    "update story_aliases set retired_at = $at where office_id = $office_id and key = $key and story_id = $to and retired_at is null",
    { key, to, at },
  );
  retireAliases(office, to, key, at);
}

/** Closes a story's key (`Removed`); its id may later become another story's current id. */
export function removeStory(office: OfficeHandle, key: StoryKey, at: number): void {
  office.run(
    "update stories set removed_at = $at where office_id = $office_id and key = $key and removed_at is null",
    { key, at },
  );
}
