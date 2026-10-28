// Migration 58 (DIPO-359): the office's starts paused (0020) replaces the plan-limit hold.
//
// - `starts_paused`: one row per office whose starts a plan limit paused, with the park detail
//   the limit gave (`detail`), when it began (`since`) and the engine-clock time it lifts by itself
//   (`until_at`; null for a limit only `dipo daemon resume-scheduling` lifts). A failed adapter
//   check pauses starts through the adapter's hold, which keeps no row here.
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
  reason text not null check (reason = 'plan-limit'),
  detail text not null,
  since integer not null,
  until_at integer,
  primary key (office_id)
) strict;

alter table parks add column resume_on_lift integer not null default 0
  check (resume_on_lift in (0, 1));

drop table plan_limit_warnings;
`,
};
