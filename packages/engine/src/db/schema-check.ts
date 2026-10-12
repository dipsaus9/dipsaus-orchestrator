// Isolation by key (0007 section 3): every office-scoped table has `office_id` as the first
// column of its primary key. The schema test runs this over the migrated database.

import type { SqlRunner } from "../platform/sqlite";

import { SOFTWARE_TABLES } from "./schema";

/** One line per office-scoped table whose primary key does not start with `office_id`. */
export function findOfficeKeyViolations(
  db: SqlRunner,
  softwareTables: ReadonlySet<string> = SOFTWARE_TABLES,
): string[] {
  const tables = db.all<{ name: string }>(
    "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
  );
  const violations: string[] = [];
  for (const { name } of tables) {
    if (softwareTables.has(name)) continue;
    const first = db.get<{ name: string }>(
      "select name from pragma_table_info($table) where pk = 1",
      { table: name },
    );
    if (first === null) {
      violations.push(
        `${name}: no primary key; office-scoped tables start their key with office_id`,
      );
    } else if (first.name !== "office_id") {
      violations.push(`${name}: primary key starts with ${first.name}, not office_id`);
    }
  }
  return violations;
}
