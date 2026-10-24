// Migration 53 (DIPO-331): `gates.hand_merge`, why only the maintainer's merge on the host decides
// a merge gate. `release-path` marks the gate of a story PR whose diff changes a path the base's
// CODEOWNERS gives an owner (the 0016 amendment of 2026-10-23): that PR needs the maintainer's
// code owner approval, which for a PR opened with the maintainer's login is the maintainer's merge
// on the host. `gate.approve` refuses such a gate and the merge slot never merges its PR; the Done
// poll decides it when the PR is merged by hand. Null for every other gate and for every gate
// before this migration.

import type { SqlMigration } from "../migrations";

export const mergeGateHandMerge: SqlMigration = {
  version: 53,
  name: "merge gate hand merge",
  sql: `
alter table gates add column hand_merge text check (hand_merge in ('release-path'));
`,
};
