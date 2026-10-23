// Migration 44 (DIPO-149): `catch_ups` (0019 sections 6 and 10, 0021 section 12; retention tier S
// with its run).
//
// One row per base merge dipo made into a story branch, or found while the story was In Review:
//
// - `merged`: dipo committed the merge of the base commit `onto_sha` into the story tip `tip_sha`
//   as `commit_sha`, from git objects in its own repository (a catch-up, DIPO-277, or the sync
//   before In Review). `conflicts` lists the paths git could not merge cleanly, with how they
//   conflicted, as a JSON array of `{path, kind}`; empty for a clean merge. These are dipo's own
//   ref journal: a clean merge recorded here, with only task-file commits after it, carries an
//   approval to the new head (0019 section 6), and a merge the journal does not hold never does.
//   The conflicted paths are what the check at done reads for conflict markers left behind.
// - `found`: the check of a story In Review found that `onto_sha` conflicts with its tip; nothing
//   was merged (`commit_sha` null). The story's next In Review or merge-slot sync handles it.

import type { SqlMigration } from "../migrations";

export const catchUps: SqlMigration = {
  version: 44,
  name: "catch ups",
  sql: `
create table catch_ups (
  office_id text not null,
  run_id text not null,
  catch_up_id integer not null check (catch_up_id > 0),
  kind text not null check (kind in ('merged', 'found')),
  base text not null,
  onto_sha text not null,
  tip_sha text not null,
  commit_sha text,
  conflicts text not null,
  at integer not null,
  primary key (office_id, run_id, catch_up_id),
  check ((kind = 'merged') = (commit_sha is not null)),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;
`,
};
