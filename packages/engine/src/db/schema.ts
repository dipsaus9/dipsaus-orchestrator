// The migrations compiled into the binary (0007 sections 4 and 9). Append new steps; never edit
// or reorder a merged one, because its checksum is recorded in every database it ran on.

import type { Migration } from "./migrations";
import { changeLogRequestsStories } from "./migrations/0002-change-log-requests-stories";
import { workerHosts } from "./migrations/0003-worker-hosts";
import { ingest } from "./migrations/0004-ingest";
import { backlogJournal } from "./migrations/0005-backlog-journal";
import { backlogMirror } from "./migrations/0006-backlog-mirror";
import { contextPacks } from "./migrations/0007-context-packs";
import { runProfiles } from "./migrations/0008-run-profiles";
import { promptPartsWorkerNotes } from "./migrations/0009-prompt-parts-worker-notes";
import { claims } from "./migrations/0010-claims";
import { pricing } from "./migrations/0011-pricing";
import { retentionIndexes } from "./migrations/0012-retention-indexes";

/**
 * Software-wide tables (0007 section 3). Every other table is office-scoped and has `office_id`
 * as the first column of its primary key.
 */
export const SOFTWARE_TABLES: ReadonlySet<string> = new Set([
  "offices",
  "schema_migrations",
  "pricing_catalogs",
  "pricing_rates",
]);

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "offices and schema_migrations",
    sql: `
create table schema_migrations (
  version integer primary key,
  name text not null,
  checksum text not null,
  engine_version text not null,
  applied_at integer not null
) strict;

create table offices (
  office_id text primary key,
  path text not null,
  display_name text not null,
  added_at integer not null,
  forgotten_at integer,
  epoch text not null,
  next_seq integer not null,
  replay_floor_seq integer not null
) strict;
`,
  },
  changeLogRequestsStories,
  workerHosts,
  ingest,
  backlogJournal,
  backlogMirror,
  contextPacks,
  runProfiles,
  promptPartsWorkerNotes,
  claims,
  pricing,
  retentionIndexes,
];
