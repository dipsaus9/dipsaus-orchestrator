// Migration 41 (DIPO-294; 0021 section 9): `verify_results.base_failures`, the failing tests of a
// box verify that also fail at the story's start commit in the same box image. A box verify whose
// failing tests are all such base failures passes; its row has `passed` 1 and the JSON list of
// those tests here, so it is recorded as a pass with known base failures, not as plain green.
// Null for every other result.

import type { SqlMigration } from "../migrations";

export const verifyBaseFailures: SqlMigration = {
  version: 41,
  name: "verify base failures",
  sql: `
alter table verify_results add column base_failures text;
`,
};
