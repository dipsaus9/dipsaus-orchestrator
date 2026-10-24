// Migration 55 (DIPO-308): when the maintainer last left an office in the TUI.
//
// `offices.tui_left_at` is the time the office's last TUI client disconnected (its last TUI
// subscription to the office stream ended: the TUI closed, switched to another office or lost its
// connection). `office.digest` counts "since you left" from it when it is asked without `since`.
// Null until a TUI has left the office once.

import type { SqlMigration } from "../migrations";

export const tuiLeft: SqlMigration = {
  version: 55,
  name: "tui left",
  sql: `
alter table offices add column tui_left_at integer;
`,
};
