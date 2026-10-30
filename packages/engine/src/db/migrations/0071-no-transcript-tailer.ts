// Migration 71 (DIPO-368): the worker transcript tailer goes. Usage comes from the worker host's
// events only (0008 section 4). Its cursors, `ingest_cursors` rows of source kind `transcript`,
// are dropped, and the check constraint is rebuilt to allow `host-events` alone (SQLite cannot
// change a check constraint). `usage_messages.output_state` (migration 35) only the tailer read,
// so it goes too.

import type { SqlMigration } from "../migrations";

export const noTranscriptTailer: SqlMigration = {
  version: 71,
  name: "no transcript tailer",
  sql: `
create table ingest_cursors_rebuilt (
  office_id text not null,
  run_id text not null,
  agent_id text not null,
  source_kind text not null check (source_kind in ('host-events')),
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
  drift_lines integer not null default 0,
  primary key (office_id, run_id, agent_id, source_kind),
  foreign key (office_id, agent_id) references agents (office_id, agent_id)
) strict;
insert into ingest_cursors_rebuilt (office_id, run_id, agent_id, source_kind, path, device, inode,
    size, read_offset, last_line_hash, last_line_bytes, parse_state, first_line_t, last_line_t,
    output_emitted_to, ended_at, changed_at, changed_detail, updated_at, drift_lines)
  select office_id, run_id, agent_id, source_kind, path, device, inode, size, read_offset,
    last_line_hash, last_line_bytes, parse_state, first_line_t, last_line_t, output_emitted_to,
    ended_at, changed_at, changed_detail, updated_at, drift_lines
  from ingest_cursors
  where source_kind = 'host-events';
drop table ingest_cursors;
alter table ingest_cursors_rebuilt rename to ingest_cursors;

alter table usage_messages drop column output_state;
`,
};
