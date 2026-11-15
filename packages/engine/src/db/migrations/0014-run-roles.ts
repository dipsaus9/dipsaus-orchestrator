// Migration 14: the role a story run runs as (DIPO-477, 0012 F12). A run takes its role from the
// story's role label and the role file on the base it claims, and keeps that role file's
// instructions, model and effort on its row, so a role file changed on the base later never
// changes its sessions. A run row from before has none of them, and its sessions use the bundled
// developer instructions. A decided start names its role too, for the `setup` view.

import type { SqlMigration } from "../migrations";

export const runRoles: SqlMigration = {
  version: 14,
  name: "run roles",
  sql: `
alter table runs add column role_instructions text;
alter table runs add column role_model text;
alter table runs add column role_effort text;

alter table run_starts add column role text not null default 'developer';
`,
};
