// `dipo stats [--office <id>]` (0007 "Size", DIPO-65): the row count and approximate bytes of each
// office-scoped table of one office, largest first, so the retention periods can be tuned. The
// office comes from `--office`, else from the repository around the current directory, as for the
// `dipo office` subcommands.

import { officeStats, type TableStats } from "@dipsaus-orchestrator/contract";

import { engineFailure, usage } from "./daemon-commands";
import { type OfficeCommandDeps, parseOptions, withOffice } from "./office-commands";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Bytes in binary units with one decimal above 1 KB: `812 B`, `7.5 MB`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} ${UNITS[0]}` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** The table, largest first, then by name, with a total line. */
export function formatStats(office: string, tables: readonly TableStats[]): string[] {
  const rows = tables.toSorted((a, b) => b.bytes - a.bytes || a.table.localeCompare(b.table));
  const total = {
    table: "total",
    rows: tables.reduce((sum, row) => sum + row.rows, 0),
    bytes: tables.reduce((sum, row) => sum + row.bytes, 0),
  };
  const cells = [...rows, total].map((row) => [
    row.table,
    row.rows.toLocaleString("en-US"),
    formatBytes(row.bytes),
  ]);
  const header = ["table", "rows", "bytes"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((cell) => cell[column]?.length ?? 0)),
  );
  const line = ([name = "", count = "", size = ""]: readonly string[]) =>
    `${name.padEnd(widths[0] ?? 0)}  ${count.padStart(widths[1] ?? 0)}  ${size.padStart(widths[2] ?? 0)}`;
  return [
    `office ${office}`,
    line(header),
    ...cells.slice(0, -1).map(line),
    line(cells.at(-1) ?? []),
    "bytes: column data of the office's rows, estimated from a sample; indexes and free pages not counted",
  ];
}

export async function statsCommand(
  args: readonly string[],
  deps: OfficeCommandDeps,
): Promise<number> {
  const options = parseOptions(args, false);
  if (typeof options === "string") return usage(deps, `stats: ${options}`);
  return withOffice(
    deps,
    options.office,
    async (session, office) => {
      const outcome = await session.read(officeStats, { office });
      if (!outcome.ok) {
        return outcome.error.code === "office.unknown"
          ? "unknown"
          : engineFailure(deps, outcome.error);
      }
      for (const line of formatStats(office, outcome.result.tables)) deps.writeLine(line);
      return 0;
    },
    undefined,
    undefined,
    "running",
  );
}
