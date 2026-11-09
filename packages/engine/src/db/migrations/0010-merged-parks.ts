// Migration 10: a park resolved as `merged` (0020, DIPO-468): the story's own PR merged while it was
// parked, so the Done poll ends the run done and resolves the park. SQLite cannot change a check
// constraint in place, so `parks` is built again with the new value and its rows copied, and its
// two indexes made again. No table refers to `parks`.

import type { SqlMigration } from "../migrations";

export const mergedParks: SqlMigration = {
  version: 10,
  name: "merged parks",
  sql: `
create table parks_next (
  office_id text not null references offices (office_id),
  park_id integer not null,
  key text not null,
  story_id text not null,
  run_id text,
  reason text not null,
  detail text not null,
  last_good_commit text,
  at integer not null,
  resolved_at integer,
  resolved_how text check (resolved_how in ('resume', 'amend', 'drop', 'discard', 'reconcile',
    'done-elsewhere', 'override', 'merged')),
  resolved_note text,
  resume_on_lift integer not null default 0 check (resume_on_lift in (0, 1)),
  check ((resolved_at is null) = (resolved_how is null)),
  primary key (office_id, park_id)
) strict;

insert into parks_next (office_id, park_id, key, story_id, run_id, reason, detail,
    last_good_commit, at, resolved_at, resolved_how, resolved_note, resume_on_lift)
  select office_id, park_id, key, story_id, run_id, reason, detail, last_good_commit, at,
    resolved_at, resolved_how, resolved_note, resume_on_lift from parks;

drop table parks;

alter table parks_next rename to parks;

create index parks_key on parks (office_id, key);
create index parks_open on parks (office_id) where resolved_at is null;
`,
};
