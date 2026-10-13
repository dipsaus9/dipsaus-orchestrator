// Migration 7 (DIPO-46): `context_packs` (0007 section 4, 0014 section 10). One row per
// worktree: the head sha and the git blob ids (JSON object, path to id) of the scope and input
// files the last context pack read, the provider and the pack's sha256. Kept until worktree
// teardown.

import type { SqlMigration } from "../migrations";

export const contextPacks: SqlMigration = {
  version: 7,
  name: "context_packs",
  sql: `
create table context_packs (
  office_id text not null references offices (office_id),
  worktree text not null,
  head_sha text not null,
  blob_ids text not null,
  provider text not null,
  pack_sha256 text not null,
  built_at integer not null,
  primary key (office_id, worktree)
) strict;
`,
};
