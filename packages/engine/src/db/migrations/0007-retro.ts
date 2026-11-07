// Migration 7: what the retro view needs and dipo did not keep (0007, DIPO-453). A run outcome
// keeps its story key and its cost, a story keeps its type, the time it became Ready, its origin
// and the time it merged, and `story_files` keeps the files a story's branch changed, so the
// rework share (a merged story whose files another story merged in the 14 days before it changed)
// can be counted by code after the runs, the PRs and the summaries have aged out.
//
// The columns of rows that exist are filled from what the database holds: the story key from the
// run, the cost from the run's agents, the merge time from the story PR. A story's Ready time,
// type, origin and files were not kept before, so they stay empty (its origin shows as unknown).

import type { SqlMigration } from "../migrations";

export const retro: SqlMigration = {
  version: 7,
  name: "retro",
  sql: `
alter table run_outcomes add column story_key text;
alter table run_outcomes add column cost_micros integer;

alter table stories add column story_type text;
alter table stories add column ready_at integer;
alter table stories add column origin text
  check (origin in ('planned', 'proposal', 'finding', 'aside', 'quick'));
alter table stories add column merged_at integer;

create table story_files (
  office_id text not null,
  key text not null,
  path text not null,
  primary key (office_id, key, path),
  foreign key (office_id, key) references stories (office_id, key)
) strict;

update run_outcomes set
  story_key = (select r.key from runs r
                where r.office_id = run_outcomes.office_id and r.run_id = run_outcomes.run_id),
  cost_micros = (select sum(t.cost_micros) from usage_totals t
                  where t.office_id = run_outcomes.office_id and t.run_id = run_outcomes.run_id);

update stories set merged_at = (select max(p.closed_at) from story_prs p
                                 where p.office_id = stories.office_id and p.key = stories.key
                                   and p.state = 'merged');
`,
};
