// Migration 74 (DIPO-432): `questions.delivered` drops `now`. Since DIPO-428 every question parks
// its story at once and DIPO-430 has the answer reach the worker with the next session only (0020),
// so `now` is never written. A stored `now` becomes `on-resume`, the way the answer was delivered.
// SQLite cannot change a check constraint, so the table is rebuilt with the same rows and the same
// indexes (as migration 38), with its foreign key to `runs`.

import type { SqlMigration } from "../migrations";

export const deliveredOnResume: SqlMigration = {
  version: 74,
  name: "delivered on-resume",
  sql: `
create table questions_rebuilt (
  office_id text not null,
  question_id text not null,
  run_id text not null,
  agent_id text not null,
  kind text not null check (kind in ('question', 'permission')),
  text text not null,
  tool text,
  input text,
  hook integer,
  asked_at integer not null,
  answer text,
  decision text check (decision in ('allow', 'deny')),
  answered_at integer,
  delivered text check (delivered in ('on-resume')),
  closed_at integer,
  closed_how text check (closed_how in ('answered', 'timeout', 'ended', 'expired')),
  park_id integer,
  allow_used_at integer,
  check ((closed_at is null) = (closed_how is null)),
  primary key (office_id, question_id),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;
insert into questions_rebuilt (office_id, question_id, run_id, agent_id, kind, text, tool, input,
    hook, asked_at, answer, decision, answered_at, delivered, closed_at, closed_how, park_id,
    allow_used_at)
  select office_id, question_id, run_id, agent_id, kind, text, tool, input, hook, asked_at, answer,
    decision, answered_at, case when delivered = 'now' then 'on-resume' else delivered end,
    closed_at, closed_how, park_id, allow_used_at
  from questions;
drop table questions;
alter table questions_rebuilt rename to questions;

create index questions_open on questions (office_id, run_id) where closed_at is null;
create index questions_allow_once on questions (office_id, run_id)
  where park_id is not null and decision = 'allow' and allow_used_at is null;
`,
};
