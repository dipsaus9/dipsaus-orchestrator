// Migration 16 (DIPO-58): `claims.teardown_started_at`, set when the teardown of a Done story
// starts its destructive git steps (0010 section 7, "Teardown"). A live claim with it set whose
// worktree and branch are both gone is a teardown a crash interrupted after `git worktree remove`
// or the branch deletion, so the next Done poll finishes its release without asking the host again.

import type { SqlMigration } from "../migrations";

export const claimTeardown: SqlMigration = {
  version: 16,
  name: "claims.teardown_started_at",
  sql: `
alter table claims add column teardown_started_at integer;
`,
};
