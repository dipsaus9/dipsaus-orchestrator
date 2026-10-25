// Migration 56 (DIPO-342): drops three tables no live path writes since the move to boxes (0007).
//
// - `verify_results` (migration 21): the verify dipo ran on the Mac at done. A box worker runs verify
//   in its box and CI checks the pushed head, so dipo never writes a row.
// - `base_verifies` (migration 40): what verify said about a base commit. Setup no longer runs it,
//   so the table was read and never written.
// - `nudge_sources` (migration 28): the context pack and input paths the developer's nudges
//   checked. A developer runs in its box with no hooks, so no nudge reads them.
//
// Their rows hold nothing a later read needs.

import type { SqlMigration } from "../migrations";

export const dropVerifyNudgeTables: SqlMigration = {
  version: 56,
  name: "drop verify_results, base_verifies and nudge_sources",
  sql: `
drop table verify_results;
drop table base_verifies;
drop table nudge_sources;
`,
};
