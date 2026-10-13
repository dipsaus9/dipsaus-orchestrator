// Migration 17 (DIPO-36): `backlog_config_previous`, the Backlog.md settings office init changed,
// with the value each had before dipo first changed it, so `office uninstall` can restore them
// (0007 section 4, 0010 sections 6 and 11). One row per office and setting; a later init never
// overwrites a row, so the value kept is always the one from before dipo. `value` is the setting
// as JSON (a list of statuses, a status name, a boolean), null when the setting was unset.

import type { SqlMigration } from "../migrations";

export const backlogConfigPrevious: SqlMigration = {
  version: 17,
  name: "backlog_config_previous",
  sql: `
create table backlog_config_previous (
  office_id text not null references offices (office_id),
  setting text not null,
  value text,
  recorded_at integer not null,
  primary key (office_id, setting)
) strict;
`,
};
