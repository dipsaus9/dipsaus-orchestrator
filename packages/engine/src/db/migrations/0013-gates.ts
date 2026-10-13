// Migration 13 (DIPO-71): `gates` and `gate_decisions` (0007 section 4). A gate is one point where
// a story waits for a decision: its kind (`ready`, `pickup`, `review`, `test`, `merge`,
// `backlog-pr`; for the Ready gate the kind is the mode), the story key, the run when there is
// one, when it opened, who it waits on until decided, and a summary. A decision records approved
// or rejected, by the maintainer or by a rule, an optional note, every rule result as a JSON array
// of `{ rule, passed, messages }` (0012 R-numbers), the story content hash it applies to (0010
// structural check) and its time.

import type { SqlMigration } from "../migrations";

export const gates: SqlMigration = {
  version: 13,
  name: "gates",
  sql: `
create table gates (
  office_id text not null references offices (office_id),
  gate_id text not null,
  kind text not null,
  key text,
  run_id text,
  opened_at integer not null,
  waiting_on text check (waiting_on in ('maintainer', 'rule')),
  summary text not null,
  primary key (office_id, gate_id),
  foreign key (office_id, key) references stories (office_id, key)
) strict;

create index gates_by_key on gates (office_id, key, kind);

create table gate_decisions (
  office_id text not null,
  gate_id text not null,
  decision text not null check (decision in ('approved', 'rejected')),
  decided_by text not null check (decided_by in ('maintainer', 'rule')),
  note text,
  rule_results text not null,
  content_hash text,
  decided_at integer not null,
  primary key (office_id, gate_id),
  foreign key (office_id, gate_id) references gates (office_id, gate_id)
) strict;

create index gate_decisions_by_hash on gate_decisions (office_id, content_hash, decision);
`,
};
