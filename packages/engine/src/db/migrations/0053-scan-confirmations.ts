// Migration 53 (DIPO-310): what the maintainer confirmed of an office's run profile, and what the
// scan fallback proposed (0013 sections 4 to 6). These rows sit beside the stored profiles, not in
// them: a rescan stores a new profile from code, and these rows lay over it when it is read, so a
// confirmation carries into every later profile until code resolves its capability.
//
// - `capability_confirmations`: per capability, the command list (JSON argument lists) and working
//   directory the maintainer confirmed, its source (`inferred` for an accepted proposal,
//   `maintainer` for an edited proposal, a hand-set command or a picked conflict candidate), the
//   evidence shown, and the profile fingerprint it was confirmed at. A confirmation whose
//   fingerprint is not the current profile's is stale: it keeps working and waits on the desk to
//   be confirmed again. These are the only facts a lost database cannot rebuild (0013 section 4).
// - `capability_proposals`: per capability, the pending proposal of the last fallback session:
//   command list, working directory, confidence `low`, the model's own confidence, the evidence it
//   named (JSON list), the fingerprint it was made at and the session run. Never executed.
// - `office_scan_marks`: the maintainer marked the product as having nothing to start (0013
//   section 2), so a missing `dev` is no deviation and no test-command refusal.
//
// Tier P: kept until `office purge`, like the profile they lay over.

import type { SqlMigration } from "../migrations";

export const scanConfirmations: SqlMigration = {
  version: 53,
  name: "scan confirmations",
  sql: `
create table capability_confirmations (
  office_id text not null references offices (office_id),
  capability text not null,
  source text not null check (source in ('inferred', 'maintainer')),
  commands text not null,
  working_dir text not null,
  evidence text not null,
  fingerprint text not null,
  confirmed_at integer not null,
  primary key (office_id, capability)
) strict;

create table capability_proposals (
  office_id text not null references offices (office_id),
  capability text not null,
  commands text not null,
  working_dir text not null,
  confidence text not null check (confidence = 'low'),
  model_confidence text not null check (model_confidence in ('high', 'medium', 'low')),
  evidence text not null,
  fingerprint text not null,
  run_id text,
  proposed_at integer not null,
  primary key (office_id, capability)
) strict;

create table office_scan_marks (
  office_id text primary key references offices (office_id),
  nothing_to_start integer not null check (nothing_to_start in (0, 1)),
  marked_at integer not null
) strict;
`,
};
