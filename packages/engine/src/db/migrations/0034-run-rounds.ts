// Migration 34 (DIPO-142): the run across review rounds and the office's session places (0019
// sections 12 and 13), and the park cause (0020 section 2).
//
// `parks.cause` says which of a reason's causes parked the story (an open string, such as `loops`,
// `ci` or `review`), so a resume reads the cause and never parses the detail. Null only on a park
// written before this migration, or one reconcile recorded from a park record written by hand.
//
// `runs.waiting` and `runs.waiting_since`: a story run reopened for a new active period (a
// maintainer resume, a fix round, a conflict hand-off, a review) whose session waits for its place
// in the office says here what it waits as, and since when; both are null once its session starts
// or when it waits for nothing. A waiting run holds no place.
//
// `run_steps.kind` gains `review-failed` (a review round whose verdict was blocked), `ci` (a pushed
// head whose required checks were red), `conflict` (a conflict hand-off) and `override` (a
// maintainer override past a blocked review), so a run's counts are read from its own history.
// SQLite cannot change a check constraint, so the table is rebuilt with the same rows.
//
// `run_outcomes` gains `end_kind` (the run's end kind; the outcome stays `parked` for a run that
// parked), `final` (1 once Done wrote the final row; until then each end rewrites it), and the
// counts retro reads: `review_rounds_failed`, `ci_attempts`, `conflict_handoffs` and `override`.

import type { SqlMigration } from "../migrations";

export const runRounds: SqlMigration = {
  version: 34,
  name: "run rounds, places and park causes",
  sql: `
alter table parks add column cause text;

alter table runs add column waiting text;
alter table runs add column waiting_since integer;

create table run_steps_rebuilt (
  office_id text not null,
  run_id text not null,
  step integer not null,
  kind text not null check (kind in ('phase', 'loop', 'review', 'review-failed', 'ci',
    'conflict', 'override')),
  value text not null,
  at integer not null,
  primary key (office_id, run_id, step),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;
insert into run_steps_rebuilt (office_id, run_id, step, kind, value, at)
  select office_id, run_id, step, kind, value, at from run_steps;
drop table run_steps;
alter table run_steps_rebuilt rename to run_steps;

alter table run_outcomes add column end_kind text;
alter table run_outcomes add column final integer not null default 0 check (final in (0, 1));
alter table run_outcomes add column review_rounds_failed integer not null default 0;
alter table run_outcomes add column ci_attempts integer not null default 0;
alter table run_outcomes add column conflict_handoffs integer not null default 0;
alter table run_outcomes add column override integer not null default 0 check (override in (0, 1));
`,
};
