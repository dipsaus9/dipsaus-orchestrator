// Migration 60 (DIPO-350): `merge_slot` goes. dipo no longer merges PRs one at a time itself: it
// turns GitHub's auto-merge on for a story PR whose merge gate was approved and for a backlog PR
// whose structural check passed, and GitHub merges once its required checks pass (0002). Whether
// auto-merge is on is GitHub's fact, read with the PR, so nothing of it is kept here. A slot
// occupant left in the table is dropped with it: the next poll reads its PR from GitHub.

import type { SqlMigration } from "../migrations";

export const dropMergeSlot: SqlMigration = {
  version: 60,
  name: "drop merge slot",
  sql: `
drop table merge_slot;
`,
};
