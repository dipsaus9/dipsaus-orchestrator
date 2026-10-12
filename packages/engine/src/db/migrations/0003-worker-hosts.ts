// Migration 3 (DIPO-44): one row per worker host (0006 decision 8, 0007 section 4). The engine
// records PID, start time, socket path and host protocol version when it starts a host; the
// processed offset advances in the same transaction as the facts derived from those bytes
// (DIPO-45), and the exit columns are filled from `exit.json`. A run may see more than one host
// (a reassign starts one for the new agent), so the agent is part of the key.

import type { SqlMigration } from "../migrations";

export const workerHosts: SqlMigration = {
  version: 3,
  name: "worker_hosts",
  sql: `
create table worker_hosts (
  office_id text not null references offices (office_id),
  run_id text not null,
  agent_id text not null,
  pid integer not null,
  start_time_ms integer not null,
  socket_path text not null,
  protocol_version integer not null,
  run_dir text not null,
  event_file text not null,
  processed_offset integer not null default 0,
  exit_code integer,
  exit_signal text,
  final_offset integer,
  ended_at integer,
  mode text not null default 'steer' check (mode in ('steer', 'follow')),
  started_at integer not null,
  primary key (office_id, run_id, agent_id)
) strict;
`,
};
