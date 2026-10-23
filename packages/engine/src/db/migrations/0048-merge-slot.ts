// Migration 48 (DIPO-150): the persisted merge slot, merge gates per head and the override park
// resolution (0019 sections 9, 11 and 16; 0020 section 15).
//
// `merge_slot` holds the office's one occupant of the merge slot, so a daemon restart continues
// with the same PR instead of forgetting it (0019 fact 1): the PR kind (`story` or `backlog`), its
// number, repository and branch, the story run of a story PR, the step it is at, the head the slot
// pushed and waits on, the host merges tried in this stay, when the slot started waiting for the
// checks of that head, whether the next sync merges the base whenever it moved (`always`, after a
// host refusal) or only on a conflict (`onConflict`), the merge of the base the sync planned (its
// commit, the tip it was made on and its conflicts, as JSON, while the step `record` moves the
// branch and records it, so a restart in between finds it), and when it entered. The slot code deletes
// the row when the PR merges or leaves the slot, so nothing of it is history: retention tier P
// with no age rule.
//
// `gates.head_sha` is the PR head a merge gate decides about, so a gate holds for that head (and a
// head a clean merge of the slot carried its approval to) and a new head opens a new gate.
// `gates.override_of` names the review gate whose blocked verdict a merge gate may override: the
// gate a `review-blocked` park opens (0019 section 11). Both are null for every other gate.
//
// `parks.resolved_how` gains `override`: a maintainer approval past a blocked review resolves the
// park (0020 section 15). SQLite cannot change a check constraint, so `parks` is rebuilt with the
// same rows and indexes.

import type { SqlMigration } from "../migrations";

export const mergeSlot: SqlMigration = {
  version: 48,
  name: "merge slot",
  sql: `
create table merge_slot (
  office_id text not null references offices (office_id),
  kind text not null check (kind in ('story', 'backlog')),
  pr_number integer not null,
  repo text not null,
  branch text not null,
  run_id text,
  phase text not null
    check (phase in ('close-out', 'sync', 'record', 'push', 'checks', 'merge')),
  pushed_head text,
  attempts integer not null default 0 check (attempts >= 0),
  checks_since integer,
  sync_mode text not null default 'onConflict' check (sync_mode in ('onConflict', 'always')),
  merge text,
  entered_at integer not null,
  primary key (office_id),
  check ((kind = 'story') = (run_id is not null))
) strict;

alter table gates add column head_sha text;
alter table gates add column override_of text;

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
    'done-elsewhere', 'override')),
  cause text,
  resolved_note text,
  check ((resolved_at is null) = (resolved_how is null)),
  primary key (office_id, park_id)
) strict;
insert into parks_rebuilt (office_id, park_id, key, story_id, run_id, reason, from_state, detail,
    last_good_commit, at, resolved_at, resolved_how, cause, resolved_note)
  select office_id, park_id, key, story_id, run_id, reason, from_state, detail, last_good_commit,
    at, resolved_at, resolved_how, cause, resolved_note from parks;
drop table parks;
alter table parks_rebuilt rename to parks;
create index parks_key on parks (office_id, key);
create index parks_open on parks (office_id) where resolved_at is null;
`,
};
