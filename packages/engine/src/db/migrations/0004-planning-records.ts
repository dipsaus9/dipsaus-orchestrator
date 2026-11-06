// Migration 4: the record of a planning session (0007, DIPO-448). One row per entry, in order per
// session: the goal, each confirmed choice (question and answer), each filed or edited story, each
// open question, and when a model session of the planning session started and ended. A fresh
// model session's first message is built from these rows.

import type { SqlMigration } from "../migrations";

export const planningRecords: SqlMigration = {
  version: 4,
  name: "planning records",
  sql: `
create table planning_records (
  office_id text not null references offices (office_id),
  session_id text not null,
  seq integer not null,
  kind text not null check (kind in ('goal', 'choice', 'story', 'question', 'started', 'ended')),
  run_id text,
  subject text,
  proposal integer,
  text text not null,
  at integer not null,
  primary key (office_id, session_id, seq)
) strict;
`,
};
