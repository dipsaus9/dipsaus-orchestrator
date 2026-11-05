// Migration 2: the maintainer's declined next-up offers (0010, DIPO-440). One row per story: the
// hash of the story as it read when it was declined, so the story is offered again once its task
// file changes, or once a run of it starts after the decline.

import type { SqlMigration } from "../migrations";

export const nextUpDeclines: SqlMigration = {
  version: 2,
  name: "next-up declines",
  sql: `
create table next_up_declines (
  office_id text not null references offices (office_id),
  key text not null,
  view_hash text not null,
  declined_at integer not null,
  primary key (office_id, key)
) strict;
`,
};
