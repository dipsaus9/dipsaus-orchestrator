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
import { gates } from "./migrations/0013-gates";
import { onceNotices } from "./migrations/0014-once-notices";
import { backlogPrs } from "./migrations/0015-backlog-prs";
import { claimTeardown } from "./migrations/0016-claim-teardown";
import { backlogConfigPrevious } from "./migrations/0017-backlog-config-previous";
import { runs } from "./migrations/0018-runs";
import { viewFacts } from "./migrations/0019-view-facts";
import { parksRunIntents } from "./migrations/0020-parks-run-intents";
import { verifyOutcomes } from "./migrations/0021-verify-outcomes";
import { questions } from "./migrations/0022-questions";
import { parkQuestions } from "./migrations/0023-park-questions";
import { runCriteria } from "./migrations/0024-run-criteria";
import { exitSignalInferred } from "./migrations/0025-exit-signal-inferred";
import { planLimitWarnings } from "./migrations/0026-plan-limit-warnings";
import { reattachGaps } from "./migrations/0027-reattach-gaps";
import { adapterVersion } from "./migrations/0029-adapter-version";

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
  gates,
  onceNotices,
  backlogPrs,
  claimTeardown,
  backlogConfigPrevious,
  runs,
  viewFacts,
  parksRunIntents,
  verifyOutcomes,
  questions,
  parkQuestions,
  runCriteria,
  exitSignalInferred,
  planLimitWarnings,
  reattachGaps,
  adapterVersion,
];
