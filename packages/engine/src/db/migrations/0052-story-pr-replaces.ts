// Migration 52 (DIPO-324): two facts of resuming a story whose box or PR another part of dipo
// moved on.
//
// - `story_prs.replaces`: the number of the closed story PR this one replaces (0020 section 2,
//   `stopped` / `pr-closed`). A story PR closed on the host without a merge parks the story; its
//   resume opens a new PR for the same run and branch, whose body names the closed one. The run's
//   row then holds the new PR, and `replaces` keeps the closed one's number so every later body
//   still names it. Null for a PR that replaces none, or before this migration.
// - `catch_ups.box_copy`: `pending` for a merge dipo committed on a story branch outside the
//   story's box (the merge slot's sync, 0019 section 9), until it is copied into the box before
//   the worker's next session; then `done`. Null for a merge made in the run's turn of parts,
//   which the box got with it, and for every merge before this migration.

import type { SqlMigration } from "../migrations";

export const storyPrReplaces: SqlMigration = {
  version: 52,
  name: "story pr replaces and box copies",
  sql: `
alter table story_prs add column replaces integer;
alter table catch_ups add column box_copy text check (box_copy in ('pending', 'done'));
`,
};
