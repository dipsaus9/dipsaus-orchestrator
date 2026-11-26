// Migration 16: the hash of the role roster a Ready gate decision was evaluated with, and the hash
// of the roster in force (0007, 0012, DIPO-516). A story view shows a stored decision only while the
// two are equal; a decision stored before has no hash and never shows.

import type { SqlMigration } from "../migrations";

export const gateRosterHash: SqlMigration = {
  version: 16,
  name: "gate roster hash",
  sql: `
alter table gate_decisions add column roster_hash text;

create table office_roster (
  office_id text not null references offices (office_id),
  roster_hash text not null,
  primary key (office_id)
) strict;
`,
};
