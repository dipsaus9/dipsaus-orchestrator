// Migration 57 (DIPO-344): every park has one of the eight reasons of 0001 and a text detail, and
// no cause (0020).
//
// Each stored reason and cause maps to one reason (0001, 0008):
//
// | Old reason / cause            | New reason        |
// |-------------------------------|-------------------|
// | `verify-failing` / `capped`   | `budget-exceeded` (a cap stopped it; only a top-up resumes it) |
// | `ambiguous-spec` / `no-report`| `worker-failed`   (no valid report after the correction turn) |
// | `on-hold`, `stopped`          | `by-maintainer`   |
// | `interrupted`                 | `worker-failed`   |
// | `needs-permission`            | `worker-failed`   (a box worker has every permission) |
// | any other unknown reason      | `worker-failed`   |
// | the eight, any other cause    | unchanged         |
//
// The reason lists of `run_outcomes.park_reasons` map the same way, by reason. The `cause` column
// goes. So does the trigger of migration 50 that expired a resolved park's
// questions in SQL without a `question.closed` entry: the engine now closes them, with their
// entries, in every transaction that resolves a park (`resolvePark`).

import type { SqlMigration } from "../migrations";

export const eightParkReasons: SqlMigration = {
  version: 57,
  name: "eight park reasons",
  sql: `
drop trigger questions_expire_with_park;

update parks set reason = 'budget-exceeded'
 where reason = 'verify-failing' and cause = 'capped';
update parks set reason = 'worker-failed'
 where reason = 'ambiguous-spec' and cause = 'no-report';
update parks set reason = 'by-maintainer' where reason in ('on-hold', 'stopped');
update parks set reason = 'worker-failed'
 where reason not in ('ambiguous-spec', 'verify-failing', 'conflict', 'scope-violation',
   'review-blocked', 'budget-exceeded', 'by-maintainer', 'worker-failed');

update run_outcomes set park_reasons = (
  select json_group_array(case
      when value in ('on-hold', 'stopped') then 'by-maintainer'
      when value in ('ambiguous-spec', 'verify-failing', 'conflict', 'scope-violation',
        'review-blocked', 'budget-exceeded', 'by-maintainer', 'worker-failed') then value
      else 'worker-failed' end)
    from json_each(run_outcomes.park_reasons))
 where json_valid(park_reasons) and exists (select 1 from json_each(run_outcomes.park_reasons)
   where value not in ('ambiguous-spec', 'verify-failing', 'conflict', 'scope-violation',
     'review-blocked', 'budget-exceeded', 'by-maintainer', 'worker-failed'));

alter table parks drop column cause;
`,
};
