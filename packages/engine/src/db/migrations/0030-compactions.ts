// Migration 30 (DIPO-106): `compactions`, the context compactions of each worker session (0008
// section 3, research 6.2). One row per compaction, numbered by `seq` within the office. The
// adapter counts a compaction once, whether its `compact_boundary` line, its `PostCompact` hook or
// both reported it. `pre_tokens` is the context
// size before the compaction; 0 when only the hook reported it. Its rows follow their agent's
// retention (0007 section 7).

import type { SqlMigration } from "../migrations";

export const compactions: SqlMigration = {
  version: 30,
  name: "compactions",
  sql: `
create table compactions (
  office_id text not null references offices (office_id),
  seq integer not null,
  run_id text not null,
  agent_id text not null,
  pre_tokens integer not null,
  at integer not null,
  primary key (office_id, seq),
  foreign key (office_id, agent_id) references agents (office_id, agent_id)
) strict;

create index compactions_agent on compactions (office_id, agent_id, seq);
`,
};
