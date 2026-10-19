// Migration 35 (DIPO-202): whether a stored message's output is in the agent's turn totals.
//
// `usage_messages.output_state` is 0 while none of the message's output is in `usage_totals` (a
// message counted by the stream after the agent's last turn end: live output stays out of the
// totals), 1 once a turn end's cumulative totals hold it, and 2 once a transcript recovery added
// it. Only a message in state 0 gets its output from a transcript; state 2 may still grow when a
// later read of the transcript holds a higher output. Messages of an agent that already had a turn
// end are taken as in the totals (1), the best a database without the marker can tell. The cost: in a
// database from before this migration, a message the stream counted after its agent's last turn end
// is never restored from a transcript.

import type { SqlMigration } from "../migrations";

export const usageOutputState: SqlMigration = {
  version: 35,
  name: "usage message output state",
  sql: `
alter table usage_messages add column output_state integer not null default 0
  check (output_state in (0, 1, 2));

update usage_messages set output_state = 1
  where exists (
    select 1 from usage_totals t
    where t.office_id = usage_messages.office_id and t.agent_id = usage_messages.agent_id
      and t.turns > 0);
`,
};
