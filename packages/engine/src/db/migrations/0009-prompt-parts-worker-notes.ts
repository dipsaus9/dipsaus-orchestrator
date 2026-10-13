// Migration 9 (DIPO-47): `prompt_parts` and `worker_notes` (0007 sections 4 and 8, 0014 sections
// 2 and 6). `prompt_parts` keeps, per run, agent and part, the sha256, UTF-8 bytes and estimated
// tokens of each prompt part, never its text; `nudges` counts the nudges sent for the part
// (DIPO-60). `worker_notes` keeps the notes of a worker's last report per worktree and agent, at
// most 1,500 characters, for the next session's handoff block; teardown deletes them (tier T).

import type { SqlMigration } from "../migrations";

export const promptPartsWorkerNotes: SqlMigration = {
  version: 9,
  name: "prompt_parts and worker_notes",
  sql: `
create table prompt_parts (
  office_id text not null references offices (office_id),
  run_id text not null,
  agent_id text not null,
  part text not null,
  sha256 text not null,
  bytes integer not null,
  est_tokens integer not null,
  nudges integer not null default 0,
  recorded_at integer not null,
  primary key (office_id, run_id, agent_id, part)
) strict;

create table worker_notes (
  office_id text not null references offices (office_id),
  worktree text not null,
  agent_id text not null,
  run_id text not null,
  story_key text,
  role text not null,
  text text not null check (length(text) <= 1500),
  recorded_at integer not null,
  primary key (office_id, worktree, agent_id)
) strict;
`,
};
