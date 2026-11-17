// Migration 15: the kind of the role a story run runs as (DIPO-503, 0012). The run keeps the kind
// its role file had at start (code, design or docs), so the scan of each part checks the area of
// that kind. A run row from before, and a role without a kind, has none: a code run.

import type { SqlMigration } from "../migrations";

export const runRoleKind: SqlMigration = {
  version: 15,
  name: "run role kind",
  sql: `
alter table runs add column role_kind text;
`,
};
