// Migration 44 (DIPO-148): `feedback_items` (0019 sections 8 and 16; retention tier S with its run).
//
// One row per feedback item a fix round carries to the worker: the run, the item's number in the
// run, its source (`verify`, `ci`, `review`, `conflict` or `reject`), its signature (sha256 over the
// fields that identify the failure; for a maintainer reject the gate id), the pushed head commit it
// was found on, the fix round that carries it, whether it repeats a signature sent for an earlier
// head, the `run_intents` row of the steer that carries it, when that steer reached a session (null
// until then), and the rendered item text, at most 3,000 characters (0014's per-item budget). The
// row is written in the same transaction as its steer intent, so a restart neither loses nor repeats
// it. One signature is stored at most once per head commit: the send-once rule of section 8.

import type { SqlMigration } from "../migrations";

export const feedbackItems: SqlMigration = {
  version: 44,
  name: "feedback items",
  sql: `
create table feedback_items (
  office_id text not null,
  run_id text not null,
  item_id integer not null check (item_id > 0),
  source text not null check (source in ('verify', 'ci', 'review', 'conflict', 'reject')),
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

create index feedback_items_intent on feedback_items (office_id, run_id, intent_id);
`,
};
