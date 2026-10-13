// Migration 13 (DIPO-39): `once_notices`, the notices an office shows only once (0008 section 2
// "Env files", 0010 amendment): the first time setup copies env files into a worktree of the
// office it shows "worktree env files hold development secrets only" and lists the files; the row
// records that it was shown, so later setups stay quiet. One row per office and notice code.

import type { SqlMigration } from "../migrations";

export const onceNotices: SqlMigration = {
  version: 13,
  name: "once_notices",
  sql: `
create table once_notices (
  office_id text not null references offices (office_id),
  code text not null,
  shown_at integer not null,
  primary key (office_id, code)
) strict;
`,
};
