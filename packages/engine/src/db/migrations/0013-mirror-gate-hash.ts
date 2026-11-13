// Migration 13: the content hash a Ready gate decision applies to, kept on the story's mirror row
// (0007, DIPO-496), so a read of a Refined story can tell a decision made for its current content
// from a stale one. Null until the next read of the story.

import type { SqlMigration } from "../migrations";

export const mirrorGateHash: SqlMigration = {
  version: 13,
  name: "mirror gate hash",
  sql: `
alter table backlog_mirror add column gate_hash text;
`,
};
