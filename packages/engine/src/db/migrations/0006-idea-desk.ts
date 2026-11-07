// Migration 6: the ideas on the maintainer's desk (0022, DIPO-454). A passed idea gets the
// maintainer's decision (`accepted` with the Backlog draft it filed, or `dismissed`, kept for
// retro); a draft a triage session promoted is recorded with the new id it got, so the story index
// renumbers its story instead of closing it; and the worker proposals' own desk table goes, since
// every proposal is an idea now and its open ones were held as ideas by migration 3.

import type { SqlMigration } from "../migrations";

export const ideaDesk: SqlMigration = {
  version: 6,
  name: "idea desk",
  sql: `
alter table ideas add column decision text
  check (decision is null or (decision in ('accepted', 'dismissed') and state = 'passed'));
alter table ideas add column decision_at integer;
alter table ideas add column draft_id text;

create table draft_promotions (
  office_id text not null references offices (office_id),
  key text not null,
  draft_id text not null,
  story_id text not null,
  promoted_at integer not null,
  primary key (office_id, key)
) strict;

drop table proposals;
`,
};
