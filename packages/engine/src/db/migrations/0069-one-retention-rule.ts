// Migration 69 (DIPO-354): the database housekeeping is one retention rule and one backup (0007).
//
// - Cost is the cost the Claude CLI reports (0008): the pricing catalogs, their rates and the
//   stale-catalog checks go. `usage_totals` loses its estimate and catalog version, and keeps the
//   CLI's cost as `cost_micros`; `usage_daily` keeps its sums as `cost_micros`, the estimates of
//   earlier days among them.
// - The change log has no tier: the one rule deletes every entry older than `retention.days`, so
//   its index is on time alone.
// - Cursors carry no epoch and replay has no floor (0005): the oldest stored entry decides.
// - A worker host ends when its exit line is ingested (DIPO-330). A host row an earlier binary
//   left open after it ingested the exit (the exit recorded, the agent ended) ends at the agent's
//   end, with the offset it was processed to as its final offset, so retention and keep-awake see
//   it as ended.

import type { SqlMigration } from "../migrations";

export const oneRetentionRule: SqlMigration = {
  version: 69,
  name: "one retention rule",
  sql: `
drop table pricing_checks;
drop table pricing_rates;
drop table pricing_catalogs;
alter table usage_totals drop column est_cost_micros;
alter table usage_totals drop column pricing_version;
alter table usage_totals rename column cli_cost_micros to cost_micros;
alter table usage_daily rename column est_cost_micros to cost_micros;

drop index change_log_tier_at;
alter table change_log drop column tier;
create index change_log_at on change_log (office_id, at);

alter table offices drop column epoch;
alter table offices drop column replay_floor_seq;

update worker_hosts
  set ended_at = (select a.ended_at from agents a
      where a.office_id = worker_hosts.office_id and a.agent_id = worker_hosts.agent_id),
    final_offset = coalesce(final_offset, processed_offset)
  where ended_at is null
    and (exit_code is not null or exit_signal is not null)
    and exists (select 1 from agents a where a.office_id = worker_hosts.office_id
      and a.agent_id = worker_hosts.agent_id and a.ended_at is not null);
`,
};
