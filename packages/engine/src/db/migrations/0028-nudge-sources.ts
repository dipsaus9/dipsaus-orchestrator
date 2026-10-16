// Migration 28 (DIPO-99): `nudge_sources`, the context pack and input paths of each session that
// the context and input nudges check (DIPO-60, 0014 section 8), apart from `prompt_parts`.
//
// One row per run, agent, kind (`context` or `input`) and repo-relative path; only the path is
// kept, never the file's text or a hash of it. Every session of a run, the first one, a resume and
// a handoff, writes its own rows, so the nudges check the paths of the session they answer.
//
// DIPO-60 stored these paths as `prompt_parts` rows named `task.context:<path>` and
// `task.inputs:<path>`, which every prompt size total then counted. They move here and leave
// `prompt_parts`, which keeps the real prompt parts and the nudges sent.

import type { SqlMigration } from "../migrations";

export const nudgeSources: SqlMigration = {
  version: 28,
  name: "nudge_sources",
  sql: `
create table nudge_sources (
  office_id text not null references offices (office_id),
  run_id text not null,
  agent_id text not null,
  kind text not null check (kind in ('context', 'input')),
  path text not null,
  recorded_at integer not null,
  primary key (office_id, run_id, agent_id, kind, path)
) strict;

insert or ignore into nudge_sources (office_id, run_id, agent_id, kind, path, recorded_at)
  select office_id, run_id, agent_id, 'context', substr(part, length('task.context:') + 1),
    recorded_at
  from prompt_parts where substr(part, 1, length('task.context:')) = 'task.context:';

insert or ignore into nudge_sources (office_id, run_id, agent_id, kind, path, recorded_at)
  select office_id, run_id, agent_id, 'input', substr(part, length('task.inputs:') + 1),
    recorded_at
  from prompt_parts where substr(part, 1, length('task.inputs:')) = 'task.inputs:';

delete from prompt_parts
  where substr(part, 1, length('task.context:')) = 'task.context:'
     or substr(part, 1, length('task.inputs:')) = 'task.inputs:';
`,
};
