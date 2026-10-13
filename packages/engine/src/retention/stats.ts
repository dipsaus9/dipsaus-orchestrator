// `office.stats { office }` (0007 "Size", DIPO-65): the row count and approximate bytes of every
// office-scoped table for one office, so the retention periods can be tuned. Tables are read from
// the schema, so a table a later migration adds shows up without a change here.
//
// Bytes are the column data of the office's rows: the average size of up to `SAMPLE_ROWS` of them
// times the row count. Integers count as their decimal text. Indexes, page overhead and free pages
// are not counted; the whole file's size is what `ls -l dipo.db` shows.

import { officeStats, type TableStats } from "@dipsaus-orchestrator/contract";

import type { FeatureModule } from "../commands/registry";
import type { OfficeHandle } from "../db/office";
import { SOFTWARE_TABLES } from "../db/schema";

/** How many rows of a table the byte estimate reads at most. */
export const SAMPLE_ROWS = 1_000;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The office-scoped tables of the schema, by name: every table with an `office_id` column. */
export function officeTables(office: OfficeHandle): string[] {
  // The join on this office's row only gives the statement its office; the schema is file-wide.
  return office
    .all<{ name: string }>(
      `select s.name from sqlite_schema s join offices o on o.office_id = $office_id
        where s.type = 'table' and s.name not like 'sqlite_%'
          and exists (select 1 from pragma_table_info(s.name) c where c.name = 'office_id')
        order by s.name`,
    )
    .map((row) => row.name)
    .filter((name) => !SOFTWARE_TABLES.has(name));
}

function columns(office: OfficeHandle, table: string): string[] {
  return office
    .all<{ name: string }>(
      `select c.name from pragma_table_info($table) c join offices o on o.office_id = $office_id
        order by c.cid`,
      { table },
    )
    .map((row) => row.name);
}

/** Row count and approximate bytes of each office-scoped table of `office`. */
export function tableStats(office: OfficeHandle): TableStats[] {
  return officeTables(office).map((table) => {
    const rows =
      office.get<{ n: number }>(
        `select count(*) as n from ${quote(table)} where office_id = $office_id`,
      )?.n ?? 0;
    if (rows === 0) return { table, rows, bytes: 0 };
    const size = columns(office, table)
      .map((column) => `coalesce(length(cast(${quote(column)} as blob)), 0)`)
      .join(" + ");
    const average =
      office.get<{ average: number | null }>(
        `select avg(size) as average from (
           select ${size} as size from ${quote(table)} where office_id = $office_id limit $sample)`,
        { sample: SAMPLE_ROWS },
      )?.average ?? 0;
    return { table, rows, bytes: Math.round(average * rows) };
  });
}

/** Registers `office.stats`; the read executor runs it in one deferred transaction. */
export const statsFeature: FeatureModule = {
  name: "retention/stats",
  register(registry) {
    registry.addRead({
      definition: officeStats,
      handle: (ctx, args) => {
        if (ctx.office === undefined) throw new Error("office.stats needs an office");
        return { office: args.office, tables: tableStats(ctx.office) };
      },
    });
  },
};
