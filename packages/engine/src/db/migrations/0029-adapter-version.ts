// Migration 29 (DIPO-101): `agents.claude_code_version` becomes `agents.adapter_version`, so no
// engine table names one worker tool. It holds the version the worker adapter reports when its
// worker starts (for Claude Code, `claude_code_version` from `system/init`); resume compares it.
// A rename keeps every stored value.

import type { SqlMigration } from "../migrations";

export const adapterVersion: SqlMigration = {
  version: 29,
  name: "adapter_version",
  sql: `
alter table agents rename column claude_code_version to adapter_version;
`,
};
