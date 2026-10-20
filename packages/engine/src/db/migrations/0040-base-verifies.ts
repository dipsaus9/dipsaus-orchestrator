// Migration 40 (DIPO-183; 0014 section 2, note of 2026-10-20): `base_verifies`, what the office's
// verify said about a base commit in the worker's own sandbox, run once after worktree setup and
// before the worker starts. One row per office, base commit and configuration hash; later runs on
// the same base read the row instead of running verify again.
//
// `passed` is 1 for a green base. For a red one `failing` is the JSON list of failing test names
// read from the runner's output, and `output_tail` holds the end of the output when no name could
// be read. A verify that could not run (the sandbox did not start, it timed out, the worktree was
// not at the base commit) stores no row, so the next run tries again.
//
// Retention tier P: one small row per base commit, kept until purge.

import type { SqlMigration } from "../migrations";

export const baseVerifies: SqlMigration = {
  version: 40,
  name: "base verifies",
  sql: `
create table base_verifies (
  office_id text not null,
  base_sha text not null,
  config_hash text not null,
  run_id text not null,
  passed integer not null check (passed in (0, 1)),
  failing text not null,
  output_tail text,
  ran_at integer not null,
  primary key (office_id, base_sha, config_hash),
  check (passed = 0 or (failing = '[]' and output_tail is null))
) strict;
`,
};
