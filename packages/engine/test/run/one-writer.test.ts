// One writer per run table (0001, DIPO-364): a scan of the product source finds no insert, update,
// replace or delete of `runs`, `parks`, `agents`, `worker_hosts` or `run_signals` outside the
// table's writer module, whether the table is named plainly, quoted or with its schema. A write
// whose table is not written out (an interpolated name, a quoted name, a string joined with `+`) is
// refused anywhere outside a short list, since the scan cannot tell which table it writes.
// Migrations are exempt. Retention deletes these tables through their writers too (DIPO-354); its
// other deletes name their table in a variable, so it stays on the short list.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Glob } from "bun";
import { describe, expect, it } from "bun:test";

const REPO = join(import.meta.dir, "..", "..", "..", "..");

/** The one module that writes each table. */
const WRITERS: Readonly<Record<string, string>> = {
  runs: "packages/engine/src/records/run-records.ts",
  parks: "packages/engine/src/run/park-records.ts",
  agents: "packages/engine/src/records/agents.ts",
  worker_hosts: "packages/engine/src/records/worker-hosts.ts",
  run_signals: "packages/engine/src/records/signals.ts",
};

const MIGRATIONS = "packages/engine/src/db/migrations/";

/** Retention's age-out deletes of tables it names in a variable (0007). */
const RETENTION = "packages/engine/src/retention/run.ts";

const RUN_TABLES = "runs|parks|agents|worker_hosts|run_signals";

/** A call of retention's unnamed delete with one of the run tables as its literal table. */
const RETENTION_ROWS = new RegExp(String.raw`\brows\(\s*["'\`](${RUN_TABLES})["'\`]`, "g");

/** A list constant (`const X = [ ... ]`), whose entries retention may pass to its unnamed delete. */
const LIST = /\bconst\s+[A-Z_]+\s*=\s*\[([^\]]*)\]/g;
const RUN_TABLE_ENTRY = new RegExp(String.raw`["'\`](${RUN_TABLES})["'\`]`, "g");

/**
 * The run tables retention names as a literal table of its unnamed delete, or lists in a constant
 * it may hand to that delete.
 */
const literal = (text: string): string[] => [
  ...[...text.matchAll(RETENTION_ROWS)].map((match) => match[1] as string),
  ...[...text.matchAll(LIST)].flatMap((list) =>
    [...(list[1] as string).matchAll(RUN_TABLE_ENTRY)].map((match) => match[1] as string),
  ),
];

/** The only files that may write a table whose name the source does not spell out. */
const DYNAMIC_ALLOWED = [RETENTION];

const VERB = String.raw`\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)`;

/** A write to one of the run tables, named plainly, quoted or with its schema. */
const NAMED = new RegExp(
  String.raw`${VERB}\s+(?:\w+\.)?["\`\[]?(runs|parks|agents|worker_hosts|run_signals)\b`,
  "gi",
);

/**
 * A write whose table name is not written out: `${`, a quote or the end of a string literal
 * right after the verb, or an interpolation between `insert` and `into`.
 */
const DYNAMIC = new RegExp(
  String.raw`(?:${VERB}\s+(?:\$\{|["'\`])|\binsert(?:\s+or\s+\w+)?\s+\$\{)`,
  "gi",
);

interface Write {
  readonly file: string;
  readonly line: number;
  /** The table, or null when the source does not name it. */
  readonly table: string | null;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function writesIn(file: string, text: string): Write[] {
  const named = [...text.matchAll(NAMED)].map((match) => ({
    file,
    line: lineOf(text, match.index),
    table: (match[1] as string).toLowerCase(),
  }));
  const dynamic = [...text.matchAll(DYNAMIC)].map((match) => ({
    file,
    line: lineOf(text, match.index),
    table: null,
  }));
  return [...named, ...dynamic].toSorted((a, b) => a.line - b.line);
}

function productWrites(): Write[] {
  const writes: Write[] = [];
  for (const file of new Glob("packages/*/src/**/*.{ts,tsx}").scanSync(REPO)) {
    if (file.endsWith(".test.ts") || file.startsWith(MIGRATIONS)) continue;
    writes.push(...writesIn(file, readFileSync(join(REPO, file), "utf8")));
  }
  return writes;
}

/** A write that breaks the rule: a table written outside its writer, or a table not named. */
function stray(write: Write): boolean {
  if (write.table === null) return !DYNAMIC_ALLOWED.includes(write.file);
  return WRITERS[write.table] !== write.file;
}

const describeWrite = (write: Write): string =>
  `${write.file}:${write.line} writes ${write.table ?? "a table it does not name"}`;

describe("one writer per run table", () => {
  const writes = productWrites();

  it("finds no write outside the table's writer, and no unnamed table outside the short list", () => {
    expect(writes.filter(stray).map(describeWrite)).toEqual([]);
  });

  it("finds retention passing none of the run tables to its unnamed delete", () => {
    expect(literal(readFileSync(join(REPO, RETENTION), "utf8"))).toEqual([]);
    // The scan sees each quoting form.
    expect(
      literal(`await rows("runs", "x"); rows('parks', y); rows(\`agents\`); rows( "worker_hosts")`),
    ).toEqual(["runs", "parks", "agents", "worker_hosts"]);
    expect(literal(`const RUN_DETAIL = ["run_steps", "run_signals"] as const;`)).toEqual([
      "run_signals",
    ]);
    expect(literal(`await rows("run_steps", "x"); batches("runs", (n) => n)`)).toEqual([]);
  });

  it("sees each writer's own writes and the allowed unnamed ones, so the scan works", () => {
    for (const [table, file] of Object.entries(WRITERS)) {
      expect(writes.some((write) => write.table === table && write.file === file)).toBe(true);
    }
    for (const file of DYNAMIC_ALLOWED) {
      expect(writes.some((write) => write.table === null && write.file === file)).toBe(true);
    }
  });

  it("catches each form a write takes", () => {
    const forms: readonly [string, string | null][] = [
      ["office.run(`update runs set x = 1`);", "runs"],
      ["office.run(`UPDATE OR IGNORE runs set x = 1`);", "runs"],
      ["office.run(`insert or ignore into agents (a) values (1)`);", "agents"],
      ["office.run(`DELETE FROM\n  worker_hosts where 1`);", "worker_hosts"],
      ["office.run(`replace into parks (a) values (1)`);", "parks"],
      ['office.run(`update "runs" set x = 1`);', "runs"],
      ["office.run(`update main.runs set x = 1`);", "runs"],
      ['office.run(`delete from main."parks" where 1`);', "parks"],
      ["office.run(`delete from [agents] where 1`);", "agents"],
      ["office.run(`delete from ${name} where 1`);", null],
      ["office.run(`insert ${mode}into agents (a) values (1)`);", null],
      ["office.run(`insert into ${table} (a) values (1)`);", null],
      ['office.run("update " + table + " set x = 1");', null],
      ["office.run('delete from ' + table);", null],
    ];
    for (const [text, table] of forms) {
      expect(writesIn("x.ts", text).map((write) => write.table)).toContain(table);
    }
  });

  it("leaves reads, other tables and words that are not SQL alone", () => {
    for (const text of [
      "office.run(`select * from runs`);",
      "office.run(`update run_outcomes set x = 1`);",
      "office.run(`insert into parks_rebuilt (a) values (1)`);",
      "office.run(`delete from agents_old where 1`);",
      'spawn(["apt-get", `update`, "install"]);',
      "// the runs update when a park ends",
    ]) {
      expect(writesIn("x.ts", text)).toEqual([]);
    }
  });

  it("refuses a table written outside its writer and an unnamed table outside the short list", () => {
    expect(stray({ file: "packages/engine/src/run/places.ts", line: 1, table: "runs" })).toBe(true);
    expect(stray({ file: WRITERS.runs as string, line: 1, table: "runs" })).toBe(false);
    expect(stray({ file: WRITERS.runs as string, line: 1, table: "parks" })).toBe(true);
    expect(stray({ file: RETENTION, line: 1, table: "runs" })).toBe(true);
    expect(stray({ file: RETENTION, line: 1, table: null })).toBe(false);
    expect(
      stray({ file: "packages/engine/src/retention/feature.ts", line: 1, table: "runs" }),
    ).toBe(true);
    expect(stray({ file: "packages/engine/src/office/purge/rows.ts", line: 1, table: null })).toBe(
      true,
    );
    expect(stray({ file: WRITERS.runs as string, line: 1, table: null })).toBe(true);
  });
});
