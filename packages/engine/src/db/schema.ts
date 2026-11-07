// The migrations compiled into the binary (0007). Append new steps; never edit or reorder a merged
// one, because its checksum is recorded in every database it ran on.

import type { Migration } from "./migrations";
import { base } from "./migrations/0001-base";
import { nextUpDeclines } from "./migrations/0002-next-up-declines";
import { ideas } from "./migrations/0003-ideas";
import { planningRecords } from "./migrations/0004-planning-records";
import { runStarts } from "./migrations/0005-run-starts";
import { proposedStories } from "./migrations/0006-proposed-stories";

/**
 * Software-wide tables (0007). Every other table is office-scoped and has `office_id` as the first
 * column of its primary key.
 */
export const SOFTWARE_TABLES: ReadonlySet<string> = new Set(["offices", "schema_migrations"]);

export const MIGRATIONS: readonly Migration[] = [
  base,
  nextUpDeclines,
  ideas,
  planningRecords,
  runStarts,
  proposedStories,
];
