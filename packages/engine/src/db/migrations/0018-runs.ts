// Migration 18 (DIPO-48): `runs`, `run_steps` and `config_snapshots` (0007 section 4 and its
// 2026-10-12 amendment, 0008 section 9).
//
// `runs` holds one row per run. `kind` is `story` (a claimed story: its key, story id at start,
// frozen branch and worktree are set) or `session` (a model session outside a story run, M1 to
// M5: no key, story, branch or worktree; its usage rows still name the office and the run). The
// row copies what the run started with: tier, role, model, start SHA, port slot, the budget unit
// and limit, the loop cap, the review round cap, the hash of the configuration in force, the
// local override keys and the run profile. A run is active until `ended_at`.
//
// `run_steps` is append-only: each phase entered, loop started or review round started, with its
// time. `config_snapshots` keeps the effective configuration (no secrets) once per office and hash,
// so `runs.config_hash` always names a configuration that can be read back.

import type { SqlMigration } from "../migrations";

export const runs: SqlMigration = {
  version: 18,
  name: "runs, run_steps and config_snapshots",
  sql: `
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
  worktree text,
  slot integer,
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
  check (
    (kind = 'story' and key is not null and story_id is not null and branch is not null
      and worktree is not null and start_sha is not null)
    or (kind = 'session' and key is null and story_id is null and branch is null
      and worktree is null)
  ),
  primary key (office_id, run_id)
) strict;

create index runs_active on runs (office_id, kind) where ended_at is null;
create index runs_key on runs (office_id, key);

create table run_steps (
  office_id text not null,
  run_id text not null,
  step integer not null,
  kind text not null check (kind in ('phase', 'loop', 'review')),
  value text not null,
  at integer not null,
  primary key (office_id, run_id, step),
  foreign key (office_id, run_id) references runs (office_id, run_id)
) strict;

create table config_snapshots (
  office_id text not null references offices (office_id),
  config_hash text not null,
  config text not null,
  first_seen integer not null,
  primary key (office_id, config_hash)
) strict;
`,
};
