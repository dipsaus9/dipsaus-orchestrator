// Migration 29 (DIPO-101): `agents.claude_code_version` becomes `agents.adapter_version`, so no
// engine table names one worker tool. It holds the version the worker adapter reports when its
// worker starts (for Claude Code, `claude_code_version` from `system/init`); resume compares it.
// A rename keeps every stored value.
//
// The version is 28 until DIPO-99's migration 28 (`0028-nudge-sources`) is on main; this step
// moves to 29 then, because versions have no gaps.

import type { SqlMigration } from "../migrations";

export const adapterVersion: SqlMigration = {
  version: 28,
  name: "adapter_version",
  sql: `
alter table agents rename column claude_code_version to adapter_version;
`,
};
