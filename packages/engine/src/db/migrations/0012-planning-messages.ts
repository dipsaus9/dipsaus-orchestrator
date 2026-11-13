// Migration 12: the maintainer's messages and the model's last answers in a planning record (0022,
// DIPO-489). Two entry kinds, `message` and `answer`, and `output_offset`, the end of the model
// session's stored output when the entry was made. SQLite cannot change a check constraint in
// place, so `planning_records` is built again and its rows copied. No table refers to it.

import type { SqlMigration } from "../migrations";

export const planningMessages: SqlMigration = {
  version: 12,
  name: "planning messages",
  sql: `
create table planning_records_next (
  office_id text not null references offices (office_id),
  session_id text not null,
  seq integer not null,
  kind text not null check (kind in ('goal', 'choice', 'story', 'question', 'started', 'ended',
    'message', 'answer')),
  run_id text,
  subject text,
  proposal integer,
  output_offset integer,
  text text not null,
  at integer not null,
  primary key (office_id, session_id, seq)
) strict;

insert into planning_records_next (office_id, session_id, seq, kind, run_id, subject, proposal,
    text, at)
  select office_id, session_id, seq, kind, run_id, subject, proposal, text, at
  from planning_records;

drop table planning_records;

alter table planning_records_next rename to planning_records;
`,
};
