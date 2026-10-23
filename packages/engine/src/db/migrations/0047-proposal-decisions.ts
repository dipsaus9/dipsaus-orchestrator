// Migration 47 (DIPO-166; 0020 sections 11c and 15): the maintainer's decision on a worker's
// proposal, on its `proposals` row (migration 43).
//
// - `decided_by`: the origin of the `proposal.accept` or `proposal.dismiss` that decided it (`cli`,
//   `tui`, ...); null while the proposal is open.
// - `draft_id`: the Backlog draft the planning lane created for an accepted proposal, such as
//   `DRAFT-4`, set when the lane applies the operation (again after a rebuild). Backlog.md reuses
//   draft ids, so it names the draft only until it is promoted or archived; the draft itself is
//   found by the proposal's marker line in its description.
//
// `updated_at` is when it was decided. Retention stays tier S (migration 43): a decided proposal
// goes `retention.stateDays` after its decision.

import type { SqlMigration } from "../migrations";

export const proposalDecisions: SqlMigration = {
  version: 47,
  name: "proposal decisions",
  sql: `
alter table proposals add column decided_by text;
alter table proposals add column draft_id text;
`,
};
