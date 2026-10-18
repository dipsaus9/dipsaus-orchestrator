// Migration 31 (DIPO-180): the dependencies and field-block branch of every active task, kept on its
// `backlog_mirror` row so the Ready gate reads the other tasks without one Backlog CLI view each.
// `gate_sha` is the `_base` commit the index pass read them at; `gate_dependencies` is a JSON array
// of task ids and `gate_branch` the frozen branch (F15), null when the block has none. Only an
// index pass writes the three columns, always together; a row without `gate_sha` was never read
// that way, and the gate then reads the tasks through the CLI.

import type { SqlMigration } from "../migrations";

export const mirrorGateTask: SqlMigration = {
  version: 31,
  name: "mirror gate task",
  sql: `
alter table backlog_mirror add column gate_sha text;
alter table backlog_mirror add column gate_dependencies text;
alter table backlog_mirror add column gate_branch text;
`,
};
