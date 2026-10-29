// Migration 65 (DIPO-349): a story has no Mac worktree and no port slot (0010, 0008). A claim is
// its branch plus its row, every read and write of the story runs on the branch ref, and a box has
// its own network, so a machine-wide port slot and a dev port of the run profile serve nothing.
//
// - `run_ports` goes: the scan no longer detects dev ports (0013).
// - `runs.worktree`, `runs.slot` and `runs.backstop_snapshot` go. `worktree` is named in the
//   table's check, which SQLite cannot change, so the table is copied: the foreign keys of the
//   tables that reference `runs` are deferred, `runs` is dropped and made again with the same rows,
//   which satisfies every reference again before the step commits (the migration runner checks
//   `foreign_key_check` too).
// - `worker_notes` and `context_packs` were kept per worktree path; they are kept per story branch
//   now. A note row takes the branch of its run's claim; a pack row the branch of the latest claim
//   that had its worktree. A row with neither is dropped: both are tier T rows the next session
//   writes again.
// - `claims` loses the worktree, its git-link snapshot (`admin_dir`, `snap_*`) and
//   `first_feedback`, the conflict of a base merge in the worktree that a claim no longer makes.
// - `done_elsewhere` loses `worktree`, `worktree_kept` and `files`: a story Done elsewhere leaves
//   at most its branch behind.
// - `leftover_worktrees`: the story worktrees an earlier binary left that dipo kept at an office
//   load because they hold changes, for the desk (`worktree/leftovers.ts`); written again at each
//   load.

import type { SqlMigration } from "../migrations";

export const noStoryWorktree: SqlMigration = {
  version: 65,
  name: "no story worktree",
  sql: `
drop table run_ports;

pragma defer_foreign_keys = on;
create table runs_kept as select office_id, run_id, kind, key, story_id, tier, role, model,
  start_sha, branch, budget_unit, budget_limit, loop_cap, review_round_cap, config_hash,
  override_keys, run_profile_id, started_at, ended_at, end_kind, scope, gate_changes, parked_ms,
  criteria_known, criteria_checked, criteria_reported, max_turns, max_minutes, waiting,
  waiting_since, web_searches, web_fetches, ci_cap, conflict_cap, review_max_turns,
  review_max_minutes, review_max_tokens
  from runs;
drop table runs;
create table runs (
  office_id text not null references offices (office_id),
  run_id text not null,
  kind text not null check (kind in ('story', 'session')),
  key text,
  story_id text,
  tier text,
  role text not null,
  model text not null,
  start_sha text,
  branch text,
  budget_unit text not null,
  budget_limit integer not null,
  loop_cap integer not null,
  review_round_cap integer,
  config_hash text not null,
  override_keys text,
  run_profile_id text,
  started_at integer not null,
  ended_at integer,
  end_kind text,
  scope text,
  gate_changes text,
  parked_ms integer not null default 0,
  criteria_known text,
  criteria_checked text,
  criteria_reported text,
  max_turns integer,
  max_minutes integer,
  waiting text,
  waiting_since integer,
  web_searches integer not null default 0,
  web_fetches integer not null default 0,
  ci_cap integer,
  conflict_cap integer,
  review_max_turns integer,
  review_max_minutes integer,
  review_max_tokens integer,
  check (
    (kind = 'story' and key is not null and story_id is not null and branch is not null
      and start_sha is not null)
    or (kind = 'session' and key is null and story_id is null and branch is null)
  ),
  primary key (office_id, run_id)
) strict;
insert into runs (office_id, run_id, kind, key, story_id, tier, role, model, start_sha, branch,
  budget_unit, budget_limit, loop_cap, review_round_cap, config_hash, override_keys,
  run_profile_id, started_at, ended_at, end_kind, scope, gate_changes, parked_ms, criteria_known,
  criteria_checked, criteria_reported, max_turns, max_minutes, waiting, waiting_since,
  web_searches, web_fetches, ci_cap, conflict_cap, review_max_turns, review_max_minutes,
  review_max_tokens)
  select office_id, run_id, kind, key, story_id, tier, role, model, start_sha, branch,
    budget_unit, budget_limit, loop_cap, review_round_cap, config_hash, override_keys,
    run_profile_id, started_at, ended_at, end_kind, scope, gate_changes, parked_ms,
    criteria_known, criteria_checked, criteria_reported, max_turns, max_minutes, waiting,
    waiting_since, web_searches, web_fetches, ci_cap, conflict_cap, review_max_turns,
    review_max_minutes, review_max_tokens
  from runs_kept;
drop table runs_kept;
create index runs_active on runs (office_id, kind) where ended_at is null;
create index runs_key on runs (office_id, key);

create table worker_notes_rekeyed (
  office_id text not null references offices (office_id),
  branch text not null,
  agent_id text not null,
  run_id text not null,
  story_key text,
  role text not null,
  text text not null check (length(text) <= 1500),
  recorded_at integer not null,
  primary key (office_id, branch, agent_id)
) strict;
insert or replace into worker_notes_rekeyed (office_id, branch, agent_id, run_id, story_key, role,
  text, recorded_at)
  select n.office_id, c.branch, n.agent_id, n.run_id, n.story_key, n.role, n.text, n.recorded_at
  from worker_notes n
  join claims c on c.office_id = n.office_id and c.run_id = n.run_id
  order by n.recorded_at;
drop table worker_notes;
alter table worker_notes_rekeyed rename to worker_notes;

create table context_packs_rekeyed (
  office_id text not null references offices (office_id),
  branch text not null,
  head_sha text not null,
  blob_ids text not null,
  provider text not null,
  pack_sha256 text not null,
  built_at integer not null,
  primary key (office_id, branch)
) strict;
insert or replace into context_packs_rekeyed (office_id, branch, head_sha, blob_ids, provider,
  pack_sha256, built_at)
  select office_id, branch, head_sha, blob_ids, provider, pack_sha256, built_at from (
    select p.office_id, p.head_sha, p.blob_ids, p.provider, p.pack_sha256, p.built_at,
      (select c.branch from claims c where c.office_id = p.office_id and c.worktree = p.worktree
        order by c.claimed_at desc limit 1) as branch
    from context_packs p
  )
  where branch is not null
  order by built_at;
drop table context_packs;
alter table context_packs_rekeyed rename to context_packs;

alter table claims drop column worktree;
alter table claims drop column admin_dir;
alter table claims drop column snap_commondir;
alter table claims drop column snap_gitdir;
alter table claims drop column snap_pointer;
alter table claims drop column first_feedback;

alter table done_elsewhere drop column worktree;
alter table done_elsewhere drop column worktree_kept;
alter table done_elsewhere drop column files;

create table leftover_worktrees (
  office_id text not null references offices (office_id),
  path text not null,
  branch text,
  why text not null,
  found_at integer not null,
  primary key (office_id, path)
) strict;
`,
};
