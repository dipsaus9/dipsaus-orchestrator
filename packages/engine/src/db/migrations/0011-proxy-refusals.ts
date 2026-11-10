// Migration 11: the model proxy's refusals (0008, DIPO-484). The proxy records each 429 it sends for
// a run's reached token cap, against the run its peer address names, so the run's ending can tell
// that 429 from the plan's limit.

import type { SqlMigration } from "../migrations";

export const proxyRefusals: SqlMigration = {
  version: 11,
  name: "proxy refusals",
  sql: `
create table proxy_refusals (
  office_id text not null,
  run_id text not null,
  refusal integer not null,
  reason text not null,
  at integer not null,
  primary key (office_id, run_id, refusal),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;
`,
};
