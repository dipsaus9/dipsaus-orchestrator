// Migration 6 (DIPO-32): `backlog_mirror`, the cache of what the story index last read from
// Backlog.md for each story key (0007 section 4). It is never a source of truth: Backlog.md is.
// One row per key, overwritten on every pass: content hash, status as the CLI printed it, kind
// (task or draft), title, tier and role from the reserved labels, every label as a JSON array, the
// read time and the source (`base`, or a story branch once claims read there).

import type { SqlMigration } from "../migrations";

export const backlogMirror: SqlMigration = {
  version: 6,
  name: "backlog_mirror",
  sql: `
create table backlog_mirror (
  office_id text not null,
  key text not null,
  content_hash text not null,
  kind text not null check (kind in ('task', 'draft')),
  status text not null,
  title text not null,
  tier text,
  role text,
  labels text not null,
  read_at integer not null,
  source text not null,
  primary key (office_id, key),
  foreign key (office_id, key) references stories (office_id, key)
) strict;
`,
};
