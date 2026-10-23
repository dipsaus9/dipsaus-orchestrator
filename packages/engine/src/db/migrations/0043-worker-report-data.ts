// Migration 43 (DIPO-186; 0008 section 1, 0014 section 2 and 0020 section 11, their notes of
// 2026-10-20): the worker report's data, kept as data.
//
// - `done_reports`: one row per done report of a run, numbered from 1 in arrival order, with its
//   test-plan entries (`test_plan`, a JSON list of `{n, status, evidence}`) and its deviations
//   (`deviations`, a JSON list of `{where, what, why}`). The review task message reads the newest.
// - `report_sendbacks`: what dipo sent back to the worker only once per run (a decision note whose
//   file or section is missing, a box worker's done report with no verify run after its last
//   edit), keyed by kind and a signature of the fact.
// - `decision_notes`: a note the worker proposes for a decision record (file, section and text),
//   stored once checked, with its story and run. dipo shows it to the maintainer and never writes
//   it to the decision records. `hash` keys a note: the same note from a later report is one row.
// - `proposals`: a report's follow-up, spike or tool proposals, deduplicated by a hash of the title
//   and the paths.
//
// The state of a note and a proposal is `open` until the maintainer decides it (DIPO-166 adds the
// actions); `accepted` and `dismissed` are allowed now so that story needs no table rebuild.
//
// Retention tier S: the run's rows go with the run; an open note or proposal is kept.

import type { SqlMigration } from "../migrations";

export const workerReportData: SqlMigration = {
  version: 43,
  name: "worker report data",
  sql: `
create table done_reports (
  office_id text not null,
  run_id text not null,
  report integer not null check (report >= 1),
  test_plan text not null,
  deviations text not null,
  at integer not null,
  primary key (office_id, run_id, report),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;
create table report_sendbacks (
  office_id text not null,
  run_id text not null,
  kind text not null check (kind in ('decision-note', 'verify-run')),
  signature text not null,
  at integer not null,
  primary key (office_id, run_id, kind, signature),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;
create table decision_notes (
  office_id text not null,
  hash text not null,
  story_key text not null,
  run_id text not null,
  file text not null,
  section text not null,
  text text not null,
  state text not null default 'open' check (state in ('open', 'accepted', 'dismissed')),
  created_at integer not null,
  updated_at integer not null,
  primary key (office_id, hash)
) strict;
create index decision_notes_state on decision_notes (office_id, state, created_at);
create table proposals (
  office_id text not null,
  hash text not null,
  story_key text not null,
  run_id text not null,
  kind text not null check (kind in ('follow-up', 'spike', 'tool')),
  title text not null,
  outcome text not null,
  why text not null,
  paths text not null,
  state text not null default 'open' check (state in ('open', 'accepted', 'dismissed')),
  created_at integer not null,
  updated_at integer not null,
  primary key (office_id, hash)
) strict;
create index proposals_state on proposals (office_id, state, created_at);
`,
};
