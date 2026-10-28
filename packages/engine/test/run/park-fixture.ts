// A park as a test sets it up (DIPO-360): the run detail row in `parks` and Backlog.md's park record
// (status Parked with the F16 `park: {reason, from, note}`) as the story index read it into
// `backlog_mirror`. The engine takes the reason and origin from Backlog.md only (`openPark`), so a
// test that parks a story by hand writes both, as a real park does.

import type { OfficeHandle } from "../../src/db/office";

export interface ParkFixture {
  /** The park id; the next free one when absent. */
  readonly parkId?: number;
  readonly key: string;
  readonly story: string;
  readonly runId?: string | null;
  readonly reason: string;
  /** The lifecycle the story left; `In Progress` when absent. */
  readonly from?: string;
  readonly detail: string;
  readonly at: number;
  readonly lastGoodCommit?: string | null;
}

/** Writes Backlog.md's park record of the story into the mirror, creating its rows when absent. */
export function mirrorParked(
  office: OfficeHandle,
  park: Pick<ParkFixture, "key" | "story" | "reason" | "from" | "detail" | "at">,
): void {
  office.run(
    `insert or ignore into stories (office_id, key, story_id, provisional, first_seen_at)
     values ($office_id, $key, $story, 0, $at)`,
    { key: park.key, story: park.story, at: park.at },
  );
  const record = JSON.stringify({
    reason: park.reason,
    from: park.from ?? "In Progress",
    note: park.detail,
  });
  office.run(
    `insert into backlog_mirror (office_id, key, content_hash, kind, status, title, labels,
       read_at, source, park, park_since)
     values ($office_id, $key, 'h', 'task', 'Parked', $story, '[]', $at, 'base', $park, $at)
     on conflict (office_id, key) do update set status = 'Parked', park = excluded.park,
       park_since = excluded.park_since`,
    { key: park.key, story: park.story, at: park.at, park: record },
  );
}

/** Inserts the park's `parks` row and its mirror record; returns the park id. */
export function insertPark(office: OfficeHandle, park: ParkFixture): number {
  mirrorParked(office, park);
  office.run(
    `insert into parks (office_id, park_id, key, story_id, run_id, reason, detail,
       last_good_commit, at)
     values ($office_id, coalesce($id, (select coalesce(max(park_id), 0) + 1 from parks
       where office_id = $office_id)), $key, $story, $run, $reason, $detail, $commit, $at)`,
    {
      id: park.parkId ?? null,
      key: park.key,
      story: park.story,
      run: park.runId ?? null,
      reason: park.reason,
      detail: park.detail,
      commit: park.lastGoodCommit ?? null,
      at: park.at,
    },
  );
  return (
    park.parkId ??
    (office.get<{ id: number }>("select max(park_id) as id from parks where office_id = $office_id")
      ?.id as number)
  );
}

/**
 * The story as the index read it, not parked: its `stories` row and a mirror row with `status`, so
 * a park the engine makes reaches the mirror as Backlog.md's read-back.
 */
export function mirrorStory(
  office: OfficeHandle,
  story: { readonly key: string; readonly story: string; readonly status?: string },
  at = 0,
): void {
  office.run(
    `insert or ignore into stories (office_id, key, story_id, provisional, first_seen_at)
     values ($office_id, $key, $story, 0, $at)`,
    { key: story.key, story: story.story, at },
  );
  office.run(
    `insert into backlog_mirror (office_id, key, content_hash, kind, status, title, labels,
       read_at, source)
     values ($office_id, $key, 'h', 'task', $status, $story, '[]', $at, 'base')
     on conflict (office_id, key) do update set status = excluded.status, park = null,
       park_since = null`,
    { key: story.key, story: story.story, status: story.status ?? "In Progress", at },
  );
}
