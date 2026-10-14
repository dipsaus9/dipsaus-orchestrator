// Migration 22 (DIPO-59): `questions` (0007 section 4; 0005 `QuestionView`, 0008 section 5).
//
// One row per question the engine put to the maintainer for a run's agent: `kind` is `permission`
// (the worker's `PermissionRequest` hook asks, 0008 section 5) or `question` (a worker question,
// later stories). `text` is what the maintainer sees; for a permission question `tool` and
// `input` are the call (the input as a one-line summary) and `hook` the waiting hook call's id
// (the hook line's end offset in the run's event file). `answer` is the text the maintainer wrote,
// `decision` the allow or deny of a permission question, `delivered` how the answer reached the
// worker (`now`, `on-resume`), and `closed_at` with `closed_how` (`answered`, `timeout`,
// `ended`: the worker exited, `expired`: a daemon restart left it unanswered) when it stopped
// waiting. Retention: tier S, with its run, ended more than `stateDays` ago (a run's end closes
// its questions).
//
// `worker_hosts.engine_token` is the secret the engine wrote into `launch.json` (which the host
// removes before the worker starts): the host lets only a connection that presents it answer a
// hook call or count as the engine watching.

import type { SqlMigration } from "../migrations";

export const questions: SqlMigration = {
  version: 22,
  name: "questions",
  sql: `
create table questions (
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
  delivered text check (delivered in ('now', 'on-resume')),
  closed_at integer,
  closed_how text check (closed_how in ('answered', 'timeout', 'ended', 'expired')),
  check ((closed_at is null) = (closed_how is null)),
  primary key (office_id, question_id),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create index questions_open on questions (office_id, run_id) where closed_at is null;

alter table worker_hosts add column engine_token text;
`,
};
