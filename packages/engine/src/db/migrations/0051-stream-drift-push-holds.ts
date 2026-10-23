// Migration 51 (DIPO-315): the stream drift count and the review hold of an unpushed story.
//
// - `ingest_cursors.drift_lines`: the worker lines of one agent's event file that failed their
//   schema or had a message type the adapter drops, counted by the ingestor in the pass that read
//   them. A run's count is the sum over its agents; at the threshold the run parks with cause
//   `stream-drift` (`ingest/ingestor.ts`). Zero for a cursor from before this migration.
// - `claims.no_remote_at`: when a push of the claim's branch found that the office has no remote,
//   so there is nothing to wait for. A run that ended In Review is reviewed only once its head is
//   on the remote (`claims.pushed_at` at or after the run's end) or the office has no remote (this
//   column at or after the run's end). Null until such a push.

import type { SqlMigration } from "../migrations";

export const streamDriftPushHolds: SqlMigration = {
  version: 51,
  name: "stream drift and push holds",
  sql: `
alter table ingest_cursors add column drift_lines integer not null default 0;
alter table claims add column no_remote_at integer;
`,
};
