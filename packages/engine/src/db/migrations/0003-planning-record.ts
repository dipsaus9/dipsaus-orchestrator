// Migration 3: the record of a planning session (DIPO-450, 0022). One row per story a confirmed
// proposal filed (`filed`) or edited (`edited`), keyed by the session's run, the proposal's number
// and the kind, so a filing the lane applies again (a rebuild that gave the story a new id) updates
// its row. The kind has no check: DIPO-448 adds the session's decisions and open questions here.

import type { SqlMigration } from "../migrations";

export const planningRecord: SqlMigration = {
  version: 3,
  name: "planning record",
  sql: `
create table planning_record (
  office_id text not null references offices (office_id),
  run_id text not null,
  proposal integer not null,
  kind text not null,
  story_id text not null,
  recorded_at integer not null,
  primary key (office_id, run_id, proposal, kind)
) strict;
`,
};
