// The row deletion of `office.purge` (0007 sections 1 and 3). Every office-scoped table carries
// `office_id` (section 3), so the tables are found from the schema, never from a list kept by hand:
// a table a later migration adds is purged too. Tables are emptied children first, in the order
// their foreign keys need, each in batches of at most 5,000 rows, one immediate transaction per
// batch sized to the 50 ms budget, with the event loop running between batches, so a large office
// never blocks the other offices. A last transaction deletes whatever a background job wrote
// meanwhile together with the `offices` row, so the office is gone at once or not at all.

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import { SOFTWARE_TABLES } from "../../db/schema";
import type { SqliteConnection, SqlRunner } from "../../platform/sqlite";
import { Slicer, type SliceOptions } from "../../retention/slices";

interface ForeignKey {
  readonly table: string;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The tables that hold office rows: every table with an `office_id` column but the software ones. */
export function officeTables(
  db: SqlRunner,
  softwareTables: ReadonlySet<string> = SOFTWARE_TABLES,
): string[] {
  return db
    .all<{ name: string }>(
      `select t.name as name from sqlite_schema t
        where t.type = 'table' and t.name not like 'sqlite_%'
          and exists (select 1 from pragma_table_info(t.name) c where c.name = 'office_id')
        order by t.name`,
    )
    .map((row) => row.name)
    .filter((name) => !softwareTables.has(name));
}

/**
 * The office tables in an order that deletes every referencing table before the table it
 * references; throws on a foreign-key cycle between tables, which batches could not delete.
 */
export function deleteOrder(db: SqlRunner, tables: readonly string[]): string[] {
  const known = new Set(tables);
  // parent -> the tables that reference it
  const referencedBy = new Map<string, Set<string>>(tables.map((name) => [name, new Set()]));
  for (const table of tables) {
    const keys = db.all<ForeignKey>('select "table" from pragma_foreign_key_list($table)', {
      table,
    });
    for (const { table: parent } of keys) {
      if (parent !== table && known.has(parent)) referencedBy.get(parent)?.add(table);
    }
  }
  const order: string[] = [];
  const left = new Set(tables);
  while (left.size > 0) {
    // A table is ready once no table still left references it.
    const ready = [...left].filter((name) =>
      [...(referencedBy.get(name) ?? [])].every((child) => !left.has(child)),
    );
    if (ready.length === 0) {
      throw new Error(`office tables reference each other in a cycle: ${[...left].join(", ")}`);
    }
    for (const name of ready) {
      order.push(name);
      left.delete(name);
    }
  }
  return order;
}

/** True when the table has a foreign key to itself; its rows go in one statement. */
function selfReferencing(db: SqlRunner, table: string): boolean {
  return db
    .all<ForeignKey>('select "table" from pragma_foreign_key_list($table)', { table })
    .some((key) => key.table === table);
}

export interface PurgeRowsOptions extends Omit<SliceOptions, "clock"> {
  readonly connection: SqliteConnection;
  readonly office: OfficeId;
  readonly clock: Clock;
}

export interface PurgeRowsReport {
  /** Rows deleted, the `offices` row included. */
  readonly rows: number;
  /** Rows deleted per table; tables with none are left out. */
  readonly deleted: Readonly<Record<string, number>>;
  /** The slowest batch, in milliseconds. */
  readonly slowestMs: number;
}

/** Deletes every row of `office`, its `offices` row last. */
export async function purgeOfficeRows(options: PurgeRowsOptions): Promise<PurgeRowsReport> {
  const { connection, office, clock } = options;
  const order = deleteOrder(connection, officeTables(connection));
  const slicer = new Slicer({
    clock,
    ...(options.maxBatch === undefined ? {} : { maxBatch: options.maxBatch }),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    ...(options.pause === undefined ? {} : { pause: options.pause }),
  });
  const deleted: Record<string, number> = {};
  const count = (table: string, n: number) => {
    if (n > 0) deleted[table] = (deleted[table] ?? 0) + n;
  };

  for (const table of order) {
    const name = quote(table);
    const whole = selfReferencing(connection, table);
    for (;;) {
      const { result, limit } = await slicer.slice((size) =>
        connection.immediate(
          () =>
            connection.run(
              `delete from ${name} where rowid in
                (select rowid from ${name} where office_id = $office limit $limit)`,
              { office, limit: whole ? -1 : size },
            ).changes,
        ),
      );
      count(table, result);
      if (whole || result < limit) break;
    }
  }

  // Whatever a background job wrote while the batches ran, and the office row, in one transaction.
  connection.immediate(() => {
    for (const table of order) {
      count(
        table,
        connection.run(`delete from ${quote(table)} where office_id = $office`, { office }).changes,
      );
    }
    count(
      "offices",
      connection.run("delete from offices where office_id = $office", { office }).changes,
    );
  });

  const rows = Object.values(deleted).reduce((sum, n) => sum + n, 0);
  return { rows, deleted, slowestMs: slicer.slowestMs };
}
