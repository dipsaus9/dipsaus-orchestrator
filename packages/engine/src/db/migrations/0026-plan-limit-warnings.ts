// Migration 26 (DIPO-92): `plan_limit_warnings`, the holds an `allowed_warning` puts on new runs
// (DIPO-61, 0008 section 7), so a hold survives a daemon restart.
//
// One row per office, adapter and scope: the office whose run warned, the adapter it ran on, the
// limit scope (`session`, `weekly`, `unknown` or `model:<family>`) and `until_at`, the engine-clock
// time the hold ends (the warning's `resetsAt`, or an hour after the warning without one). A later
// warning on the same scope moves `until_at` forward, never back. The office load step arms every
// row again and deletes the rows whose time passed while the daemon was down; the schedule deletes
// a row when its hold ends.

import type { SqlMigration } from "../migrations";

export const planLimitWarnings: SqlMigration = {
  version: 26,
  name: "plan_limit_warnings",
  sql: `
create table plan_limit_warnings (
  office_id text not null references offices (office_id),
  adapter text not null,
  scope text not null,
  until_at integer not null,
  warned_at integer not null,
  primary key (office_id, adapter, scope)
) strict;
`,
};
