// Migration 9: a run step for each part a box run's worker handed and dipo committed (0008,
// DIPO-466), valued with the part's commit, so a cap's park can say the run handed no part. SQLite
// cannot change a check constraint in place, so `run_steps` is built again with the new kind and its
// rows copied. No table refers to `run_steps`.

import type { SqlMigration } from "../migrations";

export const partSteps: SqlMigration = {
  version: 9,
  name: "part steps",
  sql: `
create table run_steps_next (
  office_id text not null,
  run_id text not null,
  step integer not null,
  kind text not null check (kind in ('phase', 'loop', 'review', 'review-failed', 'ci',
    'conflict', 'override', 'cap', 'ci-none', 'ci-rerun', 'part')),
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
