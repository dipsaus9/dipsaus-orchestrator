// Migration 8 (DIPO-72): the run profile tables (0007 section 4, 0013 section 4).
//
// - `scans`: one row per detection run: trigger (`start`, `run`, `test`, `rescan`), start and
//   finish time, the fingerprint and `_base` commit it scanned, the result (`stored` when it
//   stored a new profile, `unchanged` when detection gave the current profile again, `failed`),
//   the profile it stored and its diff from the previous one (JSON). Tier S.
// - `run_profiles`: one row per stored profile; ids count up per office. Toolchain JSON,
//   conformance level, deviations JSON, the `run` refusal (null when verify resolved), the
//   previous profile and the current flag (at most one current per office). Tier P.
// - `run_capabilities`: per profile and capability: status (`resolved`, `conflict`,
//   `unresolved`), command list JSON, working dir, source, confidence, evidence, conflict
//   candidates JSON, and the confirmed, pending and stale flags the M1 confirmation uses.
// - `run_env_files`, `run_ports`, `run_extra_scripts`: paths and names only, never env contents
//   or hashes (0013 sections 4 and 7).

import type { SqlMigration } from "../migrations";

export const runProfiles: SqlMigration = {
  version: 8,
  name: "run_profiles",
  sql: `
create table run_profiles (
  office_id text not null references offices (office_id),
  profile_id integer not null,
  scanned_at integer not null,
  commit_sha text not null,
  fingerprint text not null,
  toolchain text not null,
  conformance text not null check (conformance in ('conforming', 'partial', 'non-standard')),
  deviations text not null,
  run_refusal text,
  previous_profile_id integer,
  current integer not null check (current in (0, 1)),
  primary key (office_id, profile_id)
) strict;

create unique index run_profiles_current on run_profiles (office_id) where current = 1;

create table run_capabilities (
  office_id text not null,
  profile_id integer not null,
  capability text not null,
  status text not null check (status in ('resolved', 'conflict', 'unresolved')),
  commands text,
  working_dir text,
  source text,
  confidence text,
  evidence text,
  candidates text,
  confirmed integer not null default 0 check (confirmed in (0, 1)),
  pending integer not null default 0 check (pending in (0, 1)),
  stale integer not null default 0 check (stale in (0, 1)),
  primary key (office_id, profile_id, capability),
  foreign key (office_id, profile_id) references run_profiles (office_id, profile_id)
) strict;

create table run_env_files (
  office_id text not null,
  profile_id integer not null,
  path text not null,
  example text,
  present integer not null check (present in (0, 1)),
  ignored integer not null check (ignored in (0, 1)),
  primary key (office_id, profile_id, path),
  foreign key (office_id, profile_id) references run_profiles (office_id, profile_id)
) strict;

create table run_ports (
  office_id text not null,
  profile_id integer not null,
  dir text not null,
  port integer not null,
  source text not null,
  confidence text not null,
  evidence text not null,
  fixed_in_code integer not null check (fixed_in_code in (0, 1)),
  honours_port integer not null check (honours_port in (0, 1)),
  primary key (office_id, profile_id, dir, port),
  foreign key (office_id, profile_id) references run_profiles (office_id, profile_id)
) strict;

create table run_extra_scripts (
  office_id text not null,
  profile_id integer not null,
  name text not null,
  command text not null,
  primary key (office_id, profile_id, name),
  foreign key (office_id, profile_id) references run_profiles (office_id, profile_id)
) strict;

create table scans (
  office_id text not null references offices (office_id),
  scan_id integer not null,
  trigger text not null check (trigger in ('start', 'run', 'test', 'rescan')),
  started_at integer not null,
  finished_at integer not null,
  fingerprint text,
  commit_sha text,
  result text not null check (result in ('stored', 'unchanged', 'failed')),
  profile_id integer,
  diff text,
  error text,
  primary key (office_id, scan_id)
) strict;
`,
};
