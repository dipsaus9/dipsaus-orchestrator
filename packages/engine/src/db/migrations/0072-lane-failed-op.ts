// Migration 72 (DIPO-401): a lane-b operation the Backlog CLI failed on is closed as `failed`, with
// a notice, so it no longer blocks the operations after it (0010). The check constraint of
// `backlog_journal.state` is rebuilt to allow it (SQLite cannot change a check constraint); every
// row and the index stay as they are.

import type { SqlMigration } from "../migrations";

export const laneFailedOp: SqlMigration = {
  version: 72,
  name: "lane failed op",
  sql: `
create table backlog_journal_rebuilt (
  office_id text not null references offices (office_id),
  op_id integer not null,
  key text,
  subject text not null,
  op_kind text not null,
  target text not null,
  branch text,
  state text not null check (
    state in ('pending', 'applied', 'committed', 'pushed', 'merged', 'dropped', 'withdrawn',
      'failed')
  ),
  commit_sha text,
  pr_ref text,
  notice text,
  created_at integer not null,
  updated_at integer not null,
  closed_at integer,
  primary key (office_id, op_id)
) strict;
insert into backlog_journal_rebuilt (office_id, op_id, key, subject, op_kind, target, branch,
    state, commit_sha, pr_ref, notice, created_at, updated_at, closed_at)
  select office_id, op_id, key, subject, op_kind, target, branch, state, commit_sha, pr_ref,
    notice, created_at, updated_at, closed_at
  from backlog_journal;
drop table backlog_journal;
alter table backlog_journal_rebuilt rename to backlog_journal;
create index backlog_journal_open on backlog_journal (office_id, state, key);
`,
};
