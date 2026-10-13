// Migration 5 (DIPO-34): the lane-b journal (0007 section 4, 0010 section 2). Each planning
// operation that belongs to no story PR is journaled `pending` before any Backlog CLI call, then
// moves through `applied`, `committed` and `pushed` on the office's open engine branch until it is
// `merged`, `dropped` (it no longer applies) or `withdrawn` (0010 section 2a step 2). The op id is
// a per-office sequence, so journal order is apply order. `key` is null for an office-wide
// operation such as a configuration change; `subject` is the id the commit message names.

import type { SqlMigration } from "../migrations";

export const backlogJournal: SqlMigration = {
  version: 5,
  name: "backlog_journal",
  sql: `
create table backlog_journal (
  office_id text not null references offices (office_id),
  op_id integer not null,
  key text,
  subject text not null,
  op_kind text not null,
  target text not null,
  branch text,
  state text not null check (
    state in ('pending', 'applied', 'committed', 'pushed', 'merged', 'dropped', 'withdrawn')
  ),
  commit_sha text,
  pr_ref text,
  notice text,
  created_at integer not null,
  updated_at integer not null,
  closed_at integer,
  primary key (office_id, op_id)
) strict;

create index backlog_journal_open on backlog_journal (office_id, state, key);
`,
};
