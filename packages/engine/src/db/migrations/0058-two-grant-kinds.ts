// Migration 58 (DIPO-345): a cap grows only by a `budget` or a `round` grant (0020), and the
// reviewer has its own token cap (0002).
//
// - `run_grants.kind` keeps `budget` and gains `round`, whose amount names the counted cap it grows:
//   `{ "cap": "loops" | "reviewRounds" | "ciAttempts" | "conflictAttempts", "count": n }`. The old
//   counted kinds map to it (`loop` to `loops`, `reviewRound` to `reviewRounds`, `ciAttempt` to
//   `ciAttempts`, `conflictHandoff` to `conflictAttempts`). `reviewCap` grants go: the reviewer's
//   caps hold per session, so a fresh review needs no grant. `scope` grants go: nothing has read
//   them since references became a forecast (0001). SQLite cannot change a check constraint, so the
//   table is rebuilt.
// - `runs.review_allowance`, the tokens a review round added to the story's budget, becomes
//   `review_max_tokens`: the same snapshot of `review.budgetTokens`, now the token cap of one
//   reviewer session, counted apart from the story's budget.

import type { SqlMigration } from "../migrations";

export const twoGrantKinds: SqlMigration = {
  version: 58,
  name: "two grant kinds",
  sql: `
create table run_grants_rebuilt (
  office_id text not null,
  run_id text not null,
  grant_id text not null,
  kind text not null check (kind in ('budget', 'round')),
  amount text not null,
  note text,
  origin text not null,
  client text,
  at integer not null,
  primary key (office_id, run_id, grant_id),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;
insert into run_grants_rebuilt (office_id, run_id, grant_id, kind, amount, note, origin, client, at)
  select office_id, run_id, grant_id,
    case kind when 'budget' then 'budget' else 'round' end,
    case kind
      when 'budget' then amount
      else json_object('cap', case kind
          when 'loop' then 'loops'
          when 'reviewRound' then 'reviewRounds'
          when 'ciAttempt' then 'ciAttempts'
          else 'conflictAttempts' end,
        'count', case when json_valid(amount) and json_type(amount) in ('integer', 'real')
          then json(amount) else 0 end)
    end,
    note, origin, client, at
  from run_grants
  where kind in ('budget', 'loop', 'reviewRound', 'ciAttempt', 'conflictHandoff');
drop table run_grants;
alter table run_grants_rebuilt rename to run_grants;

alter table runs rename column review_allowance to review_max_tokens;
`,
};
