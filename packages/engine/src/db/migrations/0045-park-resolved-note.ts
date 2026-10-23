// Migration 45 (DIPO-155): `parks.resolved_note`, the maintainer's note on the resume that resolved
// a park (0020 sections 3 and 15). A note is a maintainer-authored fact (0005 section 9, 0007
// section 8): stored on the resolved park row, kept with it (retention tier S), never sent to the
// reviewer. Null for a park resolved without a note, or before this migration.

import type { SqlMigration } from "../migrations";

export const parkResolvedNote: SqlMigration = {
  version: 45,
  name: "park resolved note",
  sql: `
alter table parks add column resolved_note text;
`,
};
