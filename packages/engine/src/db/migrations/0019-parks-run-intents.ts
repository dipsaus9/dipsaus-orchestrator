// Migration 19 (DIPO-50): `parks` and `run_intents` (0007 section 4, 0008 sections 6 and 7).
//
// `parks` holds the park history of a story: one row per park with its reason (0005 `ParkReason`),
// the lifecycle it left, the detail, the last good commit (the branch tip before the park commit)
// and the time; `resolved_at` and `resolved_how` (`resume`, `amend`, `drop`, `discard`,
// `reconcile`) are set when it ends. The current park state is the F16 `park` block on the story
// branch (0012); this table is history and detail. `run_id` is null for a park without a run
// (`on-hold`). Retention: tier S, a resolved park after `stateDays`; an open park is kept.
//
// `run_intents` holds every op the engine sends to a running worker, stored as `pending` before it
// is sent (0008 section 6), so the outcome of the worker's exit is read from the intent first
// (0008 section 7). `kind` is the op (`stop`, `cap`, and `park` for closing stdin after a report
// that parks the story; `steer`, `answer`, `pause` and `reassign` for later stories); `state`
// moves to `sent` or `failed`, and to `resolved` with the `outcome` once the exit was explained.
// Retention: tier S, with its run, ended more than `stateDays` ago.

import type { SqlMigration } from "../migrations";

export const parksRunIntents: SqlMigration = {
  version: 19,
  name: "parks and run_intents",
  sql: `
create table parks (
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
  resolved_how text check (resolved_how in ('resume', 'amend', 'drop', 'discard', 'reconcile')),
  check ((resolved_at is null) = (resolved_how is null)),
  primary key (office_id, park_id)
) strict;

create index parks_key on parks (office_id, key);
create index parks_open on parks (office_id) where resolved_at is null;

create table run_intents (
  office_id text not null,
  run_id text not null,
  intent_id integer not null,
  kind text not null
    check (kind in ('steer', 'answer', 'pause', 'stop', 'reassign', 'cap', 'park')),
  detail text not null,
  state text not null check (state in ('pending', 'sent', 'failed', 'resolved')),
  created_at integer not null,
  sent_at integer,
  error text,
  resolved_at integer,
  outcome text,
  primary key (office_id, run_id, intent_id),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;
`,
};
