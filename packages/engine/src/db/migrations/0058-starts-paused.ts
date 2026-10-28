// Migration 58 (DIPO-359): the office's starts paused (0020) replaces the plan-limit hold and the
// adapter hold's own record.
//
// - `starts_paused`: the office's starts paused, at most one row per office and reason.
//   - `plan-limit`: the park detail the limit gave (`detail`), when it began (`since`) and the
//     engine-clock time it lifts by itself (`until_at`; null for a limit only `dipo daemon
//     resume-scheduling` lifts).
//   - `adapter`: a failed adapter check of the office's adapter (`adapter`), with its failures as
//     JSON (`failures`), their first line (`detail`) and when the hold began (`since`). It lifts
//     when a check passes again or by hand, never by time.
// - `parks.resume_on_lift`: 1 for a park a plan limit made, which dipo resumes by itself when the
//   office's starts paused lifts; 0 for every other park. The park's detail is text no code
//   branches on (0020), so this stored flag is what "exactly those parks" is read from.
// - `plan_limit_warnings` (migration 26) goes: an `allowed_warning` no longer holds new runs.

import type { SqlMigration } from "../migrations";

export const startsPaused: SqlMigration = {
  version: 58,
  name: "starts_paused and parks.resume_on_lift",
  sql: `
create table starts_paused (
  office_id text not null references offices (office_id),
  reason text not null check (reason in ('plan-limit', 'adapter')),
  detail text not null,
  since integer not null,
  until_at integer,
  adapter text,
  failures text,
  check ((reason = 'adapter') = (adapter is not null and failures is not null)),
  check (reason = 'plan-limit' or until_at is null),
  primary key (office_id, reason)
) strict;

alter table parks add column resume_on_lift integer not null default 0
  check (resume_on_lift in (0, 1));

drop table plan_limit_warnings;
`,
};
