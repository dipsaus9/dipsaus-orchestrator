// Migration 73 (DIPO-428): a worker's question parks its story at once, whichever client is
// connected (0001, 0020), so no question waits live any more. `questions.wait_until` (migration
// 50), the end of a live wait, is dropped: nothing writes or reads it.

import type { SqlMigration } from "../migrations";

export const noQuestionWaits: SqlMigration = {
  version: 73,
  name: "no question waits",
  sql: `
alter table questions drop column wait_until;
`,
};
