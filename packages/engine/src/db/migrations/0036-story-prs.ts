// Migration 36 (DIPO-144): `story_prs`, the PR the engine opened for a story run (0019 sections 3
// and 16; retention tier S).
//
// One row per run: the story key, the PR number and URL, the story branch, the base it targets,
// the head commit last pushed to it, its state on the host (`open`, `merged` or `closed`), the
// title and the hash of the body last written to it (the engine updates the PR only when either
// changes), and when it opened and closed. There is no row while no PR exists; a run at In Review
// without a row is a PR still to open. The run is not a foreign key: the retention of `runs` does
// not wait for the PR record.

import type { SqlMigration } from "../migrations";

export const storyPrs: SqlMigration = {
  version: 36,
  name: "story_prs",
  sql: `
create table story_prs (
  office_id text not null,
  run_id text not null,
  key text not null,
  pr_number integer not null,
  url text not null,
  branch text not null,
  base text not null,
  head_sha text not null,
  state text not null check (state in ('open', 'merged', 'closed')),
  title text not null,
  body_hash text not null,
  opened_at integer not null,
  closed_at integer,
  primary key (office_id, run_id)
) strict;

create index story_prs_key on story_prs (office_id, key);
`,
};
