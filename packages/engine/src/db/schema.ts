// The migrations compiled into the binary (0007). Append new steps; never edit or reorder a merged
// one, because its checksum is recorded in every database it ran on.

import type { Migration } from "./migrations";
import { base } from "./migrations/0001-base";
import { nextUpDeclines } from "./migrations/0002-next-up-declines";
<<<<<<< 1bb0b9e3e3e8cede5bb40e9c4280407566fe7a8a
import { planningRecords } from "./migrations/0003-planning-records";
=======
import { ideas } from "./migrations/0003-ideas";
>>>>>>> c1e3809cae86f370901a442e5048a9dee26663d6

/**
 * Software-wide tables (0007). Every other table is office-scoped and has `office_id` as the first
 * column of its primary key.
 */
export const SOFTWARE_TABLES: ReadonlySet<string> = new Set(["offices", "schema_migrations"]);

<<<<<<< 1bb0b9e3e3e8cede5bb40e9c4280407566fe7a8a
export const MIGRATIONS: readonly Migration[] = [base, nextUpDeclines, planningRecords];
=======
export const MIGRATIONS: readonly Migration[] = [base, nextUpDeclines, ideas];
>>>>>>> c1e3809cae86f370901a442e5048a9dee26663d6
