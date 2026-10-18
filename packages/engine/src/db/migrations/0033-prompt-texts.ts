// Migration 33 (DIPO-137): `prompt_texts`, the text of the prompts dipo sent a worker session when
// `privacy.storePrompts` is on (0007 section 8). Per run and agent, the `system` file and the
// first `message`; a resume stores only its message. Rows are retention tier R (`shortDays`).

import type { SqlMigration } from "../migrations";

export const promptTexts: SqlMigration = {
  version: 33,
  name: "prompt texts",
  sql: `
create table prompt_texts (
  office_id text not null,
  run_id text not null,
  agent_id text not null,
  part text not null check (part in ('system', 'message')),
  text text not null,
  recorded_at integer not null,
  primary key (office_id, run_id, agent_id, part)
) strict;

create index prompt_texts_recorded on prompt_texts (office_id, recorded_at);
`,
};
