// Migration 6: proposed user stories on the desk (0020, 0022, DIPO-454). An idea that passed the
// audit waits on the desk until the maintainer answers it: `answer` is `accepted` (filed as a
// Backlog draft, `draft_id`) or `dismissed`, kept for retro. A draft that a triage session refines
// into a story is promoted to a task with a new id: `stories.promoted_to` holds that id until the
// index sees it, so the story keeps its key (`story.renumbered`) instead of being removed and found
// again as a new story. Worker proposals are held as ideas only (DIPO-452 held the open ones), so
// the `proposals` table goes.

import type { SqlMigration } from "../migrations";

export const proposedStories: SqlMigration = {
  version: 6,
  name: "proposed stories",
  sql: `
alter table ideas add column answer text check (answer in ('accepted', 'dismissed'));
alter table ideas add column answered_at integer;
alter table ideas add column draft_id text;

alter table stories add column promoted_to text;

drop index proposals_state;
drop table proposals;
`,
};
