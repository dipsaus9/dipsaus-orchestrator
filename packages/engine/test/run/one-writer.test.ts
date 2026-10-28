// One writer per run table (0001, DIPO-364): a scan of the product source finds no insert, update,
// replace or delete of `runs`, `parks`, `agents` or `worker_hosts` outside the table's writer
// module. Migrations are exempt, and so are retention's age-out deletes until DIPO-354 cuts
// housekeeping to one rule.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { Glob } from "bun";
import { describe, expect, it } from "bun:test";

const REPO = join(import.meta.dir, "..", "..", "..", "..");

/** The one module that writes each table. */
const WRITERS: Readonly<Record<string, string>> = {
  runs: "packages/engine/src/run/records.ts",
  parks: "packages/engine/src/run/park-records.ts",
  agents: "packages/engine/src/runs/agents.ts",
  worker_hosts: "packages/engine/src/runs/worker-hosts.ts",
};

/** Paths that may write these tables besides their writers. */
const EXEMPT = [
  "packages/engine/src/db/migrations/",
  // Retention deletes the rows of runs that aged out (until DIPO-354).
  "packages/engine/src/retention/",
];

const WRITE =
  /\b(insert(?:\s+or\s+\w+)?(?:\s*\$\{[^}]*\}\s*|\s+)into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+(runs|parks|agents|worker_hosts)\b/gi;

interface Write {
  readonly file: string;
  readonly line: number;
  readonly table: string;
}

function writesIn(file: string, text: string): Write[] {
  return [...text.matchAll(WRITE)].map((match) => ({
    file,
    line: text.slice(0, match.index).split("\n").length,
    table: (match[2] as string).toLowerCase(),
  }));
}

function productWrites(): Write[] {
  const writes: Write[] = [];
  for (const path of new Glob("packages/*/src/**/*.{ts,tsx}").scanSync(REPO)) {
    const file = relative(REPO, join(REPO, path));
    if (file.endsWith(".test.ts") || EXEMPT.some((prefix) => file.startsWith(prefix))) continue;
    writes.push(...writesIn(file, readFileSync(join(REPO, file), "utf8")));
  }
  return writes;
}

describe("one writer per run table", () => {
  const writes = productWrites();

  it("finds no write outside the table's writer", () => {
    const strays = writes.filter((write) => WRITERS[write.table] !== write.file);
    expect(strays.map((write) => `${write.file}:${write.line} writes ${write.table}`)).toEqual([]);
  });

  it("sees each writer's own writes, so the scan works", () => {
    for (const [table, file] of Object.entries(WRITERS)) {
      expect(writes.some((write) => write.table === table && write.file === file)).toBe(true);
    }
  });

  it("catches the forms a write takes", () => {
    const text = [
      "office.run(`update runs set x = 1`);",
      "office.run(`insert or ignore into agents (a) values (1)`);",
      "office.run(`insert ${mode}into agents (a) values (1)`);",
      "office.run(`DELETE FROM\n  worker_hosts where 1`);",
      "office.run(`insert into parks (a) values (1)`);",
      "office.run(`select * from runs`);",
      "office.run(`update run_outcomes set x = 1`);",
      "office.run(`insert into parks_rebuilt (a) values (1)`);",
    ].join("\n");
    expect(writesIn("x.ts", text).map((write) => write.table)).toEqual([
      "runs",
      "agents",
      "agents",
      "worker_hosts",
      "parks",
    ]);
  });
});
