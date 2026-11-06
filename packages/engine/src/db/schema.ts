// The migrations compiled into the binary (0007). Append new steps; never edit or reorder a merged
// one, because its checksum is recorded in every database it ran on.

import type { Migration } from "./migrations";
import { base } from "./migrations/0001-base";
import { nextUpDeclines } from "./migrations/0002-next-up-declines";
import { ideas } from "./migrations/0003-ideas";
<<<<<<< a3c53499afadbe6d931b9eb0de559d51ab63e9b2
import { planningRecords } from "./migrations/0004-planning-records";
=======
import { planningRecord } from "./migrations/0004-planning-record";
>>>>>>> 3e768dfb903d7e05d5e95c751aae1ec3408eccf9

/**
 * Software-wide tables (0007). Every other table is office-scoped and has `office_id` as the first
 * column of its primary key.
 */
export const SOFTWARE_TABLES: ReadonlySet<string> = new Set(["offices", "schema_migrations"]);

<<<<<<< a3c53499afadbe6d931b9eb0de559d51ab63e9b2
export const MIGRATIONS: readonly Migration[] = [base, nextUpDeclines, ideas, planningRecords];
=======
export const MIGRATIONS: readonly Migration[] = [base, nextUpDeclines, ideas, planningRecord];
>>>>>>> 3e768dfb903d7e05d5e95c751aae1ec3408eccf9
