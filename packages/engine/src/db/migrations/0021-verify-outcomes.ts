// Migration 21 (DIPO-49): `verify_results`, `run_summaries` and `run_outcomes` (0007 section 4 and
// its 2026-10-12 amendment), and two run facts verify and commit need (0010 section 7, 0013
// section 5, 0014 section 3).
//
// `runs.scope` is the declared scope (F8) the run started with, a JSON array of repo-relative
// paths; the scope check at `done` reads it, so a worker cannot widen it by editing the task file.
// `runs.gate_changes` lists the gate commands (`test`, `lint`, `typecheck`, `verify`) the story
// branch changed against the base run profile, a JSON array of lines, null when none changed.
//
// `verify_results` holds one row per verify command list the engine ran: the loop it ran in, which
// profile it came from (`branch`, or `base` when the branch changed a gate script), the commands,
// exit code or signal, whether it timed out, the duration, the byte range of its output in
// `output_chunks` (source `verify`) and, once the code is committed green, the code tree key.
// Tier S with its run; its output is tier R through `output_chunks`.
//
// `run_summaries` is built at run end without a model: the final worker report (JSON, null when
// the worker gave none), the diffstat, the last verify result (JSON, null when verify never ran)
// and the last 50 output lines. Tier S with its run.
//
// `run_outcomes` keeps one row per ended run until `office purge` (tier P): what retro and tier
// tuning need after the run's detail aged out. It has no foreign key to `runs` on purpose.

import type { SqlMigration } from "../migrations";

export const verifyOutcomes: SqlMigration = {
  version: 21,
  name: "verify_results, run_summaries and run_outcomes",
  sql: `
alter table runs add column scope text;
alter table runs add column gate_changes text;

create table verify_results (
  office_id text not null,
  run_id text not null,
  result_id integer not null,
  loop integer not null,
  profile text not null check (profile in ('branch', 'base')),
  commands text not null,
  exit_code integer,
  signal text,
  timed_out integer not null check (timed_out in (0, 1)),
  passed integer not null check (passed in (0, 1)),
  duration_ms integer not null,
  output_from integer not null,
  output_to integer not null,
  code_tree_key text,
  at integer not null,
  primary key (office_id, run_id, result_id),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create table run_summaries (
  office_id text not null,
  run_id text not null,
  report text,
  diffstat text not null,
  verify text,
  output_tail text not null,
  built_at integer not null,
  primary key (office_id, run_id),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create table run_outcomes (
  office_id text not null references offices (office_id),
  run_id text not null,
  story_id text,
  tier text,
  role text not null,
  model text not null,
  outcome text not null,
  park_reasons text not null,
  loops integer not null,
  review_rounds integer not null,
  verify_failures integer not null,
  budget_tokens integer not null,
  minutes real not null,
  criteria_count integer,
  scope_size integer,
  ended_at integer not null,
  primary key (office_id, run_id)
) strict;
`,
};
