// Migration 19 (DIPO-52): the facts the story and work views are derived from (0005 sections 5
// and 6, 0009 section 3).
//
// `backlog_mirror` gains what the story index reads from each story's view: `waiting_on`, the
// dependencies that are not Done (a JSON array of ids, null when none), `park`, the field block's
// park record while the story is Parked (JSON `{ reason, from, note }`, null otherwise),
// `park_since`, when the index first saw that park record, and `criteria_met` and
// `criteria_total`, the acceptance criteria checked and in all. Like the rest of the mirror they
// are a cache of Backlog.md, overwritten on every pass.
//
// `run_signals` holds the watchdog signals of a run (`work.observed`): the signal, when it was
// raised and when it cleared, for example `quiet` on the next line. A signal is in effect while
// `cleared_at` is null. Its rows go with their run (retention tier S).

import type { SqlMigration } from "../migrations";

export const viewFacts: SqlMigration = {
  version: 19,
  name: "backlog_mirror view facts and run_signals",
  sql: `
alter table backlog_mirror add column waiting_on text;
alter table backlog_mirror add column park text;
alter table backlog_mirror add column park_since integer;
alter table backlog_mirror add column criteria_met integer;
alter table backlog_mirror add column criteria_total integer;

create table run_signals (
  office_id text not null,
  run_id text not null,
  signal text not null,
  since integer not null,
  cleared_at integer,
  primary key (office_id, run_id, signal, since),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create index run_signals_active on run_signals (office_id, run_id) where cleared_at is null;
`,
};
