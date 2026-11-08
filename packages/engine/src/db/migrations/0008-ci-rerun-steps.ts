// Migration 8: a run step for a rerun of CI failures that are GitHub's (0002, DIPO-465). A red head
// whose failed required checks are all infrastructure failures gets its failed jobs rerun, and each
// rerun is a `ci-rerun` step valued with the head: not a CI attempt. SQLite cannot change a check
// constraint in place, so `run_steps` is built again with the new kind and its rows copied. No
// table refers to `run_steps`.

import type { SqlMigration } from "../migrations";

export const ciRerunSteps: SqlMigration = {
  version: 8,
  name: "ci rerun steps",
  sql: `
create table run_steps_next (
  office_id text not null,
  run_id text not null,
  step integer not null,
  kind text not null check (kind in ('phase', 'loop', 'review', 'review-failed', 'ci',
    'conflict', 'override', 'cap', 'ci-none', 'ci-rerun')),
  value text not null,
  at integer not null,
  primary key (office_id, run_id, step),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

insert into run_steps_next (office_id, run_id, step, kind, value, at)
  select office_id, run_id, step, kind, value, at from run_steps;

drop table run_steps;

alter table run_steps_next rename to run_steps;
`,
};
