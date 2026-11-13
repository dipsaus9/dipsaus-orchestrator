// The stories a role is still the label of (DIPO-474): a role may be removed only when none of
// these is left (0017). Read from the mirror of the base, inside the caller's transaction.

import type { OfficeHandle } from "../db/office";
import { ROLE_PREFIX } from "../story-store/fields/labels";

/** The ids of the stories, drafts included, not Done and not removed, labelled `role:<name>`. */
export function openStoriesOfRole(office: OfficeHandle, name: string): string[] {
  return office
    .all<{ story_id: string }>(
      `select s.story_id from stories s
         join backlog_mirror m on m.office_id = s.office_id and m.key = s.key
        where s.office_id = $office_id and s.removed_at is null and m.status <> 'Done'
          and exists (select 1 from json_each(m.labels) where value = $label)
        order by s.story_id`,
      { label: `${ROLE_PREFIX}${name}` },
    )
    .map((row) => row.story_id);
}
