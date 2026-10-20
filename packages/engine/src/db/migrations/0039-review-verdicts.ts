// Migration 39 (DIPO-146): `review_verdicts` and the review loop's caps on `runs` (0019 sections 4,
// 5, 6 and 16; 0020 section 5).
//
// `review_verdicts` (retention tier S) holds one row per review gate: the run and story, the
// round, the reviewer agent and model, the reviewed commit and its code tree key (0010: the hash of
// `git ls-tree -r HEAD` without the story's task file), the computed verdict, the per-criterion
// results, the findings as code judged them, the summary, the validation notes, the URL of the PR
// comment, the commit an approval was carried from and the maintainer's override. The gate is not
// a foreign key: the retention of `gates` does not wait for the verdict.
//
// `runs` gains the caps the run snapshots at its start next to `review_round_cap`: `ci_cap`
// (`mergeSlot.ciAttempts`), `conflict_cap` (`mergeSlot.conflictAttempts`), the reviewer's own
// `review_max_turns` and `review_max_minutes`, and `review_allowance` (`review.budgetTokens`, added
// to the budget per review round started). Null on a run started before them.

import type { SqlMigration } from "../migrations";

export const reviewVerdicts: SqlMigration = {
  version: 39,
  name: "review verdicts",
  sql: `
create table review_verdicts (
  office_id text not null,
  gate_id text not null,
  run_id text not null,
  key text not null,
  round integer not null check (round > 0),
  agent_id text,
  model text not null,
  commit_sha text not null,
  code_tree_key text not null,
  verdict text not null check (verdict in ('approved', 'blocked')),
  criteria text not null,
  findings text not null,
  summary text not null,
  validation_notes text not null,
  comment_url text,
  carried_from text,
  override_note text,
  override_at integer,
  decided_at integer not null,
  primary key (office_id, gate_id),
  check ((override_note is null) = (override_at is null))
) strict;

create index review_verdicts_tree on review_verdicts (office_id, run_id, code_tree_key);
create index review_verdicts_key on review_verdicts (office_id, key, decided_at);

alter table runs add column ci_cap integer;
alter table runs add column conflict_cap integer;
alter table runs add column review_max_turns integer;
alter table runs add column review_max_minutes integer;
alter table runs add column review_allowance integer;
`,
};
