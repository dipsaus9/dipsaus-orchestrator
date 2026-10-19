// Migration 38 (DIPO-205): `run_steps.kind` gains `cap`, the cap a done report's turn crossed (0008
// amendment of 2026-10-19). The run took the normal done path instead of parking; the step keeps
// the crossed cap and its detail. SQLite cannot change a check constraint, so the table is rebuilt
// with the same rows.

import type { SqlMigration } from "../migrations";

export const runStepCap: SqlMigration = {
  version: 38,
  name: "run step cap",
  sql: `
create table run_steps_rebuilt (
  office_id text not null,
  run_id text not null,
  step integer not null,
  kind text not null check (kind in ('phase', 'loop', 'review', 'review-failed', 'ci',
    'conflict', 'override', 'cap')),
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
