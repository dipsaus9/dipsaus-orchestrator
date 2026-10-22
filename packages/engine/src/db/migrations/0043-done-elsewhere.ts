// Migration 43 (DIPO-161; 0020 sections 10 and 15): a story finished outside dipo.
//
// `parks.resolved_how` gains `done-elsewhere`: the park of a claim the Done poll or reconcile
// released because the story is Done on the base through another branch. SQLite cannot change a
// check constraint, so the table is rebuilt with the same rows and its indexes.
//
// `done_elsewhere` holds one row per claim found Done on the base through another branch, keyed by
// the claim's run:
// - `flagged_at`: the release waited for a live worker (a DONE ELSEWHERE desk item); null when the
//   claim was parked or idle when it was found.
// - `released_at`: the claim was released as `done-elsewhere` (or, for an own-branch teardown a
//   crash interrupted, as `done`); null while it waits for the worker.
// - `base_commit`: the base commit that last changed the story's task file, the evidence.
// - `settled_at`: the story PR, the worktree and the branch were handled; null until then, so a
//   crash after the release is finished by the next Done poll or reconcile.
// - `worktree_kept`, `branch_kept`, `commits` (JSON `[{sha, subject}]` not on the base) and `files`
//   (JSON paths uncommitted or untracked): what was kept, the LEFTOVERS desk item. Never deleted
//   automatically (decision 5); `cleared_at` and `cleared_how` (`discard`) say when `dipo discard`
//   removed them.
// Retention: tier S, cleared more than `stateDays` ago; leftovers not cleared are kept.

import type { SqlMigration } from "../migrations";

export const doneElsewhere: SqlMigration = {
  version: 43,
  name: "done elsewhere",
  sql: `
create table parks_rebuilt (
  office_id text not null references offices (office_id),
  park_id integer not null,
  key text not null,
  story_id text not null,
  run_id text,
  reason text not null,
  from_state text not null,
  detail text not null,
  last_good_commit text,
  at integer not null,
  resolved_at integer,
  resolved_how text check (resolved_how in ('resume', 'amend', 'drop', 'discard', 'reconcile',
    'done-elsewhere')),
  cause text,
  check ((resolved_at is null) = (resolved_how is null)),
  primary key (office_id, park_id)
) strict;
insert into parks_rebuilt (office_id, park_id, key, story_id, run_id, reason, from_state, detail,
    last_good_commit, at, resolved_at, resolved_how, cause)
  select office_id, park_id, key, story_id, run_id, reason, from_state, detail, last_good_commit,
    at, resolved_at, resolved_how, cause from parks;
drop table parks;
alter table parks_rebuilt rename to parks;
create index parks_key on parks (office_id, key);
create index parks_open on parks (office_id) where resolved_at is null;

create table done_elsewhere (
  office_id text not null references offices (office_id),
  run_id text not null,
  key text not null,
  story_id text not null,
  branch text not null,
  worktree text not null,
  base text not null,
  base_commit text,
  flagged_at integer,
  released_at integer,
  settled_at integer,
  worktree_kept integer not null default 0 check (worktree_kept in (0, 1)),
  branch_kept integer not null default 0 check (branch_kept in (0, 1)),
  commits text not null default '[]',
  files text not null default '[]',
  cleared_at integer,
  cleared_how text check (cleared_how in ('discard')),
  check ((cleared_at is null) = (cleared_how is null)),
  primary key (office_id, run_id)
) strict;

create index done_elsewhere_key on done_elsewhere (office_id, key);
`,
};
