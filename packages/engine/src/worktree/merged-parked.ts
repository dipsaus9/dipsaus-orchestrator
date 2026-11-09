// A story whose own PR merged while it was parked (0020, DIPO-468). The merge is the fact: the one
// Done check (`done-check.ts`) answers merged, so the Done poll (`done.ts`) tears the claim down as
// for any merged story, and in the teardown's own transaction resolves the story's open park as
// `merged` (`resolveMergedParks`). The story PR carried the park's "status Parked" commit to the
// base, so the base still says Parked: once the claim is released, the Done poll asks the planning
// lane to write Done (`mergedParksAwaitingDone`), and the backlog PR check accepts that Parked to
// Done because the one Done check answers merged for it (`backlog/pr/merged.ts`).
//
// Until the base says Done the desk shows one line for the story (`mergedParkDeskItems`): its PR
// merged while it was parked, and dipo sets it Done. The line goes once the story index reads Done.

import type { StoryKey } from "@dipsaus-orchestrator/contract";

import type { NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { openParkIds, resolvePark } from "../run-state/park-records";

/** The desk kind of a story whose PR merged while it was parked, until the base says Done. */
export const MERGED_WHILE_PARKED = "MERGED WHILE PARKED";

/** Inside the caller's transaction: every open park of the story resolved as `merged`. */
export function resolveMergedParks(office: OfficeHandle, key: StoryKey, at: number): NewEntry[] {
  return openParkIds(office, key).flatMap((park) => resolvePark(office, park, "merged", at));
}

/** A story whose park was resolved as `merged` and that the story index does not read Done yet. */
export interface MergedPark {
  readonly key: StoryKey;
  readonly story: string;
  /** The story PR that merged, when dipo recorded it for the park's run. */
  readonly pr: { readonly number: number; readonly url: string } | null;
  /** When the park was resolved, in ms. */
  readonly at: number;
}

/**
 * The stories whose newest park was resolved as `merged` while the story index's read of them is
 * not Done, oldest first: the Done poll writes Done for each through the planning lane, and the
 * desk shows each as one line. A story the index never read is left out.
 */
export function mergedParksAwaitingDone(office: OfficeHandle): MergedPark[] {
  return office
    .all<{
      key: string;
      story_id: string;
      resolved_at: number;
      number: number | null;
      url: string | null;
    }>(
      `select p.key, p.story_id, p.resolved_at, s.pr_number as number, s.url from parks p
         join backlog_mirror m on m.office_id = p.office_id and m.key = p.key and m.kind = 'task'
         left join story_prs s on s.office_id = p.office_id and s.run_id = p.run_id
        where p.office_id = $office_id and p.resolved_how = 'merged' and m.status <> 'Done'
          and p.park_id = (select max(park_id) from parks q
            where q.office_id = p.office_id and q.key = p.key)
        order by p.resolved_at, p.park_id`,
    )
    .map((row) => ({
      key: row.key as StoryKey,
      story: row.story_id,
      pr: row.number === null || row.url === null ? null : { number: row.number, url: row.url },
      at: row.resolved_at,
    }));
}

/** The desk line of each story whose PR merged while it was parked, until the base says Done. */
export function mergedParkDeskItems(office: OfficeHandle): {
  readonly kind: string;
  readonly key: StoryKey;
  readonly story: string;
  readonly detail: string;
  readonly since: number;
  readonly actions: readonly never[];
}[] {
  return mergedParksAwaitingDone(office).map((park) => ({
    kind: MERGED_WHILE_PARKED,
    key: park.key,
    story: park.story,
    detail: `${park.pr === null ? "its PR" : `its PR #${park.pr.number}`} merged while it was parked; dipo ended its run and sets it Done through its backlog PR`,
    since: park.at,
    actions: [],
  }));
}
