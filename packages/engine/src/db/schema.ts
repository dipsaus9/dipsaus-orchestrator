// The migrations compiled into the binary (0007). Append new steps; never edit or reorder a merged
// one, because its checksum is recorded in every database it ran on.

import type { Migration } from "./migrations";
import { base } from "./migrations/0001-base";
import { nextUpDeclines } from "./migrations/0002-next-up-declines";
<<<<<<< a315ae40412a50f88422a2d1252c1936f3d7d725
import { planningRecord } from "./migrations/0003-planning-record";
=======
import { ideas } from "./migrations/0003-ideas";
>>>>>>> c1e3809cae86f370901a442e5048a9dee26663d6

/**
 * Software-wide tables (0007). Every other table is office-scoped and has `office_id` as the first
 * column of its primary key.
 */
export const SOFTWARE_TABLES: ReadonlySet<string> = new Set(["offices", "schema_migrations"]);

<<<<<<< a315ae40412a50f88422a2d1252c1936f3d7d725
export const MIGRATIONS: readonly Migration[] = [base, nextUpDeclines, planningRecord];
=======
export const MIGRATIONS: readonly Migration[] = [base, nextUpDeclines, ideas];
>>>>>>> c1e3809cae86f370901a442e5048a9dee26663d6
