// Migration 10 (DIPO-38): `claims` and `released_branches` (0007 section 4, 0010 sections 2a and 7).
//
// `claims` holds one row per claim, keyed by the run that claimed: the story's key and id at the
// claim, its frozen branch and `<root>/<ID>` worktree, the base and the commit the worktree started
// from, the claim commit, whether a released branch was reused, the run-start snapshot of the
// worktree's git links (0008 section 2: admin dir, its `commondir` and `gitdir`, and the worktree's
// `.git` pointer), the first feedback for the worker (a code conflict when a reused branch merged
// the base), and the release. A claim is live while `released_at` is null; a story and a branch
// have at most one live claim.
//
// `released_branches` records a branch kept for its story when a claim was released (0010 section
// 2a); a later claim of the same StoryKey reuses it and sets `reclaimed_at`.

import type { SqlMigration } from "../migrations";

export const claims: SqlMigration = {
  version: 10,
  name: "claims and released_branches",
  sql: `
create table claims (
  office_id text not null references offices (office_id),
  run_id text not null,
  key text not null,
  story_id text not null,
  branch text not null,
  worktree text not null,
  base text not null,
  base_sha text not null,
  start_sha text not null,
  claim_sha text,
  reused integer not null check (reused in (0, 1)),
  admin_dir text not null,
  snap_commondir text not null,
  snap_gitdir text not null,
  snap_pointer text not null,
  first_feedback text,
  claimed_at integer not null,
  pushed_at integer,
  released_at integer,
  release_reason text,
  primary key (office_id, run_id)
) strict;

create unique index claims_live_key on claims (office_id, key) where released_at is null;
create unique index claims_live_branch on claims (office_id, branch) where released_at is null;
create index claims_branch on claims (office_id, branch);

create table released_branches (
  office_id text not null references offices (office_id),
  branch text not null,
  released_at integer not null,
  key text not null,
  reason text not null,
  reclaimed_at integer,
  reclaimed_by text,
  primary key (office_id, branch, released_at)
) strict;

create index released_branches_open on released_branches (office_id, key, branch)
  where reclaimed_at is null;
`,
};
