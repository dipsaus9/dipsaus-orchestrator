// Migration 2 (DIPO-22): story identity, the office change log and the idempotency records
// (0007 section 4, 0005 sections 2, 6 and 9). Every table is office-scoped, so `office_id` leads
// each primary key (0007 section 3).

import type { SqlMigration } from "../migrations";

export const changeLogRequestsStories: SqlMigration = {
  version: 2,
  name: "stories, story_aliases, change_log and requests",
  sql: `
create table stories (
  office_id text not null references offices (office_id),
  key text not null,
  story_id text not null,
  provisional integer not null check (provisional in (0, 1)),
  frozen_branch text,
  backlog_created text,
  first_seen_at integer not null,
  removed_at integer,
  primary key (office_id, key)
) strict;

create unique index stories_current_id on stories (office_id, story_id) where removed_at is null;

create table story_aliases (
  office_id text not null,
  key text not null,
  story_id text not null,
  valid_from integer not null,
  retired_at integer,
  primary key (office_id, key, story_id),
  foreign key (office_id, key) references stories (office_id, key)
) strict;

create index story_aliases_live on story_aliases (office_id, story_id) where retired_at is null;

create table change_log (
  office_id text not null references offices (office_id),
  seq integer not null,
  at integer not null,
  type text not null,
  tier text not null check (tier in ('S', 'R')),
  key text,
  run_id text,
  caused_by text,
  delta text not null,
  view text,
  primary key (office_id, seq)
) strict;

create table requests (
  office_id text not null references offices (office_id),
  request_id text not null,
  command text not null,
  args_hash text not null,
  reply text not null,
  at integer not null,
  primary key (office_id, request_id)
) strict;
`,
};
