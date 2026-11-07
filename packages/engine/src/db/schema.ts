// The migrations compiled into the binary (0007). Append new steps; never edit or reorder a merged
// one, because its checksum is recorded in every database it ran on.

import type { Migration } from "./migrations";
import { base } from "./migrations/0001-base";
import { nextUpDeclines } from "./migrations/0002-next-up-declines";
import { ideas } from "./migrations/0003-ideas";
<<<<<<< 10d2521c06c73c873b91abd674a36f1027f386fa
import { planningRecord } from "./migrations/0004-planning-record";
import { ideaDesk } from "./migrations/0005-idea-desk";
=======
import { planningRecords } from "./migrations/0004-planning-records";
import { runStarts } from "./migrations/0005-run-starts";
>>>>>>> f6a6de3f204aef137bfc56f479ffed3f79cd7ed3

/**
 * Software-wide tables (0007). Every other table is office-scoped and has `office_id` as the first
 * column of its primary key.
 */
export const SOFTWARE_TABLES: ReadonlySet<string> = new Set(["offices", "schema_migrations"]);

export const MIGRATIONS: readonly Migration[] = [
  base,
  nextUpDeclines,
  ideas,
<<<<<<< 10d2521c06c73c873b91abd674a36f1027f386fa
  planningRecord,
  ideaDesk,
=======
  planningRecords,
  runStarts,
>>>>>>> f6a6de3f204aef137bfc56f479ffed3f79cd7ed3
];
