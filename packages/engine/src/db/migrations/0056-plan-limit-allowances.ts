// Migration 56 (DIPO-338): the maintainer's plan-limit allowance (0008 section 7), and what the
// office limits read shows of a warning hold.
//
// - `plan_limit_allowances`: at most one row per office. While `until_at` (engine clock) is ahead,
//   the office's new sessions go on past the `allowed_warning` holds on the weekly, model-family
//   and unknown scopes; a rejected limit and the five-hour (`session`) window still hold. `by` is
//   the origin of the `limits.allow` that set it (`cli`, `tui`, ...), `allowed_at` when, and `note`
//   the maintainer's reason. The row is deleted by `limits.allow --clear` and once its time passed.
// - `plan_limit_warnings.utilization`: the plan's utilization of the latest warning on the scope,
//   when the adapter read it (0 to 1).
// - `plan_limit_warnings.rejected`: 1 when the hold came from a rejected limit (a reviewer's, which
//   holds the same way as a warning), which an allowance never lifts. Once 1 it stays 1.
//
// Tier P with the warnings: both end by themselves.

import type { SqlMigration } from "../migrations";

export const planLimitAllowances: SqlMigration = {
  version: 56,
  name: "plan limit allowances",
  sql: `
create table plan_limit_allowances (
  office_id text primary key references offices (office_id),
  until_at integer not null,
  note text not null,
  by text not null,
  allowed_at integer not null
) strict;

alter table plan_limit_warnings add column utilization real;
alter table plan_limit_warnings add column rejected integer not null default 0
  check (rejected in (0, 1));
`,
};
