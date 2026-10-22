// Migration 42 (DIPO-296): the live numbers of an agent's turn in progress.
//
// A worker session is one turn from the CLI's view: one task message, one result at its end. Turns
// and output join `usage_totals` only at that result (0008 section 4), so the live view showed
// 0 turns and 0 output for a whole session. `live_turns` and `live_output` hold what the stream
// reported of the turn in progress (the main agent's model turns so far, and the output of each
// message whose final count the stream gave), on the agent's main model row. They are for the
// live view only: the caps and `budget_used` never read them, the turn end and the agent's end set
// them to 0, and `usage_daily` never gets them.

import type { SqlMigration } from "../migrations";

export const usageLive: SqlMigration = {
  version: 42,
  name: "usage live numbers",
  sql: `
alter table usage_totals add column live_turns integer not null default 0
  check (live_turns >= 0);
alter table usage_totals add column live_output integer not null default 0
  check (live_output >= 0);
`,
};
