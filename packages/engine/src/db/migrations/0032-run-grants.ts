// Migration 32 (DIPO-143): a run's turn and minute caps at its start, next to its budget and loop
// caps (0020 section 5), and `run_grants`, the grants a run was given after it started (0020
// section 15). The start snapshot never changes; a run's caps are the snapshot plus its grants,
// read by `runCaps` (`run/caps.ts`). `max_turns` and `max_minutes` are null for a run that started
// before this migration; `runCaps` then reads the office tier for them, as it did before.
//
// A grant has a `kind` (`budget`, `loop`, `reviewRound`, `ciAttempt`, `conflictHandoff`,
// `reviewCap` or `scope`), its `amount` as JSON, who gave it (`origin`, and the `client` when a
// client sent it) and when. Rows are kept with their run (retention tier S).

import type { SqlMigration } from "../migrations";

export const runGrants: SqlMigration = {
  version: 32,
  name: "run caps and run grants",
  sql: `
alter table runs add column max_turns integer;
alter table runs add column max_minutes integer;

create table run_grants (
  office_id text not null,
  run_id text not null,
  grant_id text not null,
  kind text not null check (kind in ('budget', 'loop', 'reviewRound', 'ciAttempt',
    'conflictHandoff', 'reviewCap', 'scope')),
  amount text not null,
  note text,
  origin text not null,
  client text,
  at integer not null,
  primary key (office_id, run_id, grant_id),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;
`,
};
