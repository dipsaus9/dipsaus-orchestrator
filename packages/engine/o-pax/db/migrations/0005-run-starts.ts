// Migration 5: the starts `work.run` decided (DIPO-456). One row per story whose start was
// decided and answered and whose run row is not in yet: the overview shows it in the `setup`
// phase from the decision, the queue no longer lists it as Ready, and a second run of it answers
// that it is already starting. The row goes with the run row's transaction, or with the notice of
// a start that ended without one; an office load clears the rows of starts a daemon restart cut
// short.

import type { SqlMigration } from "../migrations";

export const runStarts: SqlMigration = {
  version: 5,
  name: "run starts",
  sql: `
create table run_starts (
  office_id text not null references offices (office_id),
  run_id text not null,
  key text not null,
  story_id text not null,
  agent_id text not null,
  tier text not null,
  model text not null,
  loop_cap integer not null,
  started_at integer not null,
  primary key (office_id, run_id)
) strict;

create unique index run_starts_key on run_starts (office_id, key);
`,
};
