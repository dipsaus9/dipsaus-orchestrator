// Migration 63 (DIPO-309): the maintainer's tests of a story's pushed head (0002, 0007).
//
// - `acceptance_tests`: one row per test. The story key and its run, the head it tests, its test
//   gate (`gates` of kind `test`), the test box's name, the manual steps it shows (JSON), the URL
//   on the Mac and the forwarder behind it (its port on the Mac's loopback and the box address and
//   port it reaches), when it started and when the product ran. A record writes the result
//   (`pass` or `fail`), the note and its time; every close writes `ended_at` and why. At most one
//   open test (no `ended_at`) per story.
// - `gates.waits`: the reasons a merge gate waits for the maintainer, as a JSON array of their
//   kinds, so a test pass can decide a gate whose only reason was the test-before-merge flag. A
//   gate opened before this migration has none, and a pass leaves it as it is.
// - `feedback_items.source` gains `test`: a failed test's note goes to the worker as a fix round
//   item keyed on the test id. SQLite cannot change a check, so the table is copied.

import type { SqlMigration } from "../migrations";

export const acceptanceTests: SqlMigration = {
  version: 63,
  name: "acceptance tests",
  sql: `
create table acceptance_tests (
  office_id text not null,
  test_id text not null,
  key text not null,
  run_id text not null,
  head_sha text not null,
  gate_id text,
  box text not null,
  steps text not null,
  url text,
  forward_port integer,
  target_address text,
  target_port integer,
  started_at integer not null,
  ready_at integer,
  result text check (result in ('pass', 'fail')),
  note text,
  recorded_at integer,
  ended_at integer,
  end_reason text,
  primary key (office_id, test_id),
  foreign key (office_id, key) references stories (office_id, key),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create unique index acceptance_tests_open on acceptance_tests (office_id, key)
  where ended_at is null;
create index acceptance_tests_by_run on acceptance_tests (office_id, run_id, head_sha);

alter table gates add column waits text;

create table feedback_items_next (
  office_id text not null,
  run_id text not null,
  item_id integer not null check (item_id > 0),
  source text not null check (source in ('verify', 'ci', 'review', 'conflict', 'reject', 'test')),
  signature text not null,
  head_sha text not null,
  round integer not null check (round > 0),
  repeat integer not null check (repeat in (0, 1)),
  intent_id integer not null,
  sent_at integer,
  text text not null check (length(text) <= 3000),
  created_at integer not null,
  primary key (office_id, run_id, item_id),
  unique (office_id, run_id, signature, head_sha),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

insert into feedback_items_next select office_id, run_id, item_id, source, signature, head_sha,
  round, repeat, intent_id, sent_at, text, created_at from feedback_items;
drop table feedback_items;
alter table feedback_items_next rename to feedback_items;
create index feedback_items_intent on feedback_items (office_id, run_id, intent_id);
`,
};
