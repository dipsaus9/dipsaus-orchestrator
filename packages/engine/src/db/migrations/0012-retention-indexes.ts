// Migration 12 (DIPO-65): indexes for the retention jobs (0007 section 7). Each hourly pass deletes
// rows older than a cutoff in batches of at most 5,000; without an index on the time column every
// batch would scan all of the office's rows, which a 50 ms slice cannot afford once the state tier
// holds a year of change-log entries.

import type { SqlMigration } from "../migrations";

export const retentionIndexes: SqlMigration = {
  version: 12,
  name: "retention indexes",
  sql: `
create index change_log_tier_at on change_log (office_id, tier, at);
create index requests_at on requests (office_id, at);
create index output_chunks_at on output_chunks (office_id, at);
create index usage_messages_at on usage_messages (office_id, at);
`,
};
