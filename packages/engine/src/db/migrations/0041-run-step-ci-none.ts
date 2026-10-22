// Migration 41 (DIPO-299, 0021 amendment of 2026-10-22): `run_steps.kind` gains `ci-none`, a
// pushed head of a box run for which the host reported no check at all within the bounded wait.
// CI is the verify of a box run; an office whose story PRs get no CI is not held waiting for it,
// the review decides, and this step records on the run that no CI ran for that head (its value is
// the head commit). It is not a CI attempt: the run's CI cap counts only `ci`. SQLite cannot
// change a check constraint, so the table is rebuilt with the same rows.

import type { SqlMigration } from "../migrations";

export const runStepCiNone: SqlMigration = {
  version: 41,
  name: "run step ci-none",
  sql: `
create table run_steps_rebuilt (
  office_id text not null,
  run_id text not null,
  step integer not null,
  kind text not null check (kind in ('phase', 'loop', 'review', 'review-failed', 'ci',
    'conflict', 'override', 'cap', 'ci-none')),
  value text not null,
  at integer not null,
  primary key (office_id, run_id, step),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;
insert into run_steps_rebuilt (office_id, run_id, step, kind, value, at)
  select office_id, run_id, step, kind, value, at from run_steps;
drop table run_steps;
alter table run_steps_rebuilt rename to run_steps;
`,
};
