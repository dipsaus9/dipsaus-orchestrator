// Migration 58 (DIPO-360): `parks.from_state` goes. The lifecycle a parked story returns to is
// Backlog.md's, the `from` of the story's F16 park record (0001, 0007, 0010); the engine reads it
// through `openPark`. `parks` keeps run detail and history: the reason a park was made with stays,
// as history no code reads as the current reason.

import type { SqlMigration } from "../migrations";

export const parkOriginInBacklog: SqlMigration = {
  version: 58,
  name: "park origin in backlog",
  sql: `
alter table parks drop column from_state;
`,
};
