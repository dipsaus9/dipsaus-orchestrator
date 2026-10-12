// Migration 4 (DIPO-45): worker event ingestion (0007 sections 4, 5 and 8). Agents, usage per
// message, per run and agent, and per day, stored worker output, and the cursor each run's event
// file is read from. Every table is office-scoped, so `office_id` leads each primary key.
//
// Cache creation is stored as its total and its 5 minute and 1 hour parts (0007 section 4).
// Per-message `output` is what the message reports, which may be a placeholder until the turn
// ends; run totals take output from the turn end. In `usage_totals` the two parts are the sum over
// counted messages, while `cache_create` is replaced by the adapter's cumulative total at each
// turn end. Estimated cost columns stay null until pricing (DIPO-62).

import type { SqlMigration } from "../migrations";

export const ingest: SqlMigration = {
  version: 4,
  name: "agents, usage, output_chunks and ingest_cursors",
  sql: `
create table agents (
  office_id text not null references offices (office_id),
  agent_id text not null,
  run_id text not null,
  role text not null,
  model text not null,
  effort text,
  session_id text,
  system_hash text,
  claude_code_version text,
  init_rejected text,
  started_at integer not null,
  ended_at integer,
  end_reason text,
  primary key (office_id, agent_id)
) strict;

create index agents_run on agents (office_id, run_id);

create table usage_messages (
  office_id text not null,
  agent_id text not null,
  message_id text not null,
  run_id text not null,
  model text not null,
  input integer not null,
  output integer not null,
  cache_create integer not null,
  cache_create_5m integer not null,
  cache_create_1h integer not null,
  cache_read integer not null,
  at integer not null,
  primary key (office_id, agent_id, message_id),
  foreign key (office_id, agent_id) references agents (office_id, agent_id)
) strict;

create table usage_totals (
  office_id text not null,
  run_id text not null,
  agent_id text not null,
  model text not null,
  role text not null,
  tier text not null,
  input integer not null default 0,
  output integer not null default 0,
  cache_create integer not null default 0,
  cache_create_5m integer not null default 0,
  cache_create_1h integer not null default 0,
  cache_read integer not null default 0,
  turns integer not null default 0,
  elapsed_ms integer not null default 0,
  budget_unit text not null default 'tokens',
  budget_used integer not null default 0,
  budget_limit integer not null default 0,
  est_cost_micros integer,
  pricing_version text,
  final integer not null default 0 check (final in (0, 1)),
  updated_at integer not null,
  primary key (office_id, run_id, agent_id, model),
  foreign key (office_id, agent_id) references agents (office_id, agent_id)
) strict;

create table usage_daily (
  office_id text not null references offices (office_id),
  day text not null,
  role text not null,
  tier text not null,
  model text not null,
  input integer not null default 0,
  output integer not null default 0,
  cache_create integer not null default 0,
  cache_create_5m integer not null default 0,
  cache_create_1h integer not null default 0,
  cache_read integer not null default 0,
  turns integer not null default 0,
  runs integer not null default 0,
  est_cost_micros integer,
  budget_used integer not null default 0,
  budget_limit_sum integer not null default 0,
  primary key (office_id, day, role, tier, model)
) strict;

create table output_chunks (
  office_id text not null references offices (office_id),
  run_id text not null,
  source text not null check (source in ('worker', 'verify', 'script')),
  from_offset integer not null,
  to_offset integer not null,
  agent_id text,
  text text not null,
  at integer not null,
  primary key (office_id, run_id, source, from_offset)
) strict;

create table ingest_cursors (
  office_id text not null,
  run_id text not null,
  agent_id text not null,
  source_kind text not null check (source_kind in ('host-events', 'transcript')),
  path text not null,
  device integer,
  inode integer,
  size integer not null default 0,
  read_offset integer not null default 0,
  last_line_hash text,
  last_line_bytes integer,
  parse_state text not null,
  first_line_t integer,
  last_line_t integer,
  output_emitted_to integer not null default 0,
  ended_at integer,
  changed_at integer,
  changed_detail text,
  updated_at integer not null,
  primary key (office_id, run_id, agent_id, source_kind),
  foreign key (office_id, agent_id) references agents (office_id, agent_id)
) strict;
`,
};
