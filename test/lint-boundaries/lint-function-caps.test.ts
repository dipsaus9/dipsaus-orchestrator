// Asserts the function size caps (DIPO-127): max-lines-per-function 100, complexity 20 and
// max-params 5 fire in packages/*/src outside the exception lists, stay off in tests, and a
// listed file is exempt only from the rule whose list names it. All placements are linted in one
// oxlint run; each sits at its own path so every diagnostic is attributed to one placement.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { LINT_TIMEOUT_MS, lintTree, type Diagnostic } from "./lint-tree";

const LINES = "max-lines-per-function";
const COMPLEXITY = "complexity";
const PARAMS = "max-params";
const CAPS = [LINES, COMPLEXITY, PARAMS] as const;
type Cap = (typeof CAPS)[number];

const OVER: Record<Cap, string> = {
  [LINES]: "long-function.ts",
  [COMPLEXITY]: "complex-function.ts",
  [PARAMS]: "many-params.ts",
};
const AT_CAP = ["long-function-at-cap.ts", "complex-function-at-cap.ts", "many-params-at-cap.ts"];

type Override = { files: string[]; rules: Record<string, unknown> };

const REPO = join(import.meta.dir, "..", "..");

/** The repository's oxlint config. It is JSONC: comments sit on lines of their own. */
function readConfig(): { overrides: Override[] } {
  const text = readFileSync(join(REPO, ".oxlintrc.json"), "utf8");
  const json = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return JSON.parse(json) as { overrides: Override[] };
}

/** The exception list of each cap: the one override that switches only that rule off. */
function exceptionLists(): Record<Cap, string[]> {
  const lists = {} as Record<Cap, string[]>;
  for (const cap of CAPS) {
    const blocks = readConfig().overrides.filter(
      (o) => Object.keys(o.rules).length === 1 && o.rules[cap] === "off",
    );
    expect(blocks).toHaveLength(1);
    lists[cap] = blocks[0]!.files;
  }
  return lists;
}

/** A listed file of `listed` that no other list names, so only that one cap is off for it. */
function onlyIn(lists: Record<Cap, string[]>, listed: Cap): string {
  const others = CAPS.filter((c) => c !== listed).flatMap((c) => lists[c]);
  const file = lists[listed].find((f) => !others.includes(f));
  if (file === undefined) throw new Error(`every file in the ${listed} list is in another list`);
  return file;
}

type Case = { name: string; fixture: string; target: string; expected: string[] };

function cases(): Case[] {
  const lists = exceptionLists();
  const out: Case[] = [];
  for (const cap of CAPS) {
    for (const dir of ["packages/engine/src/run", "packages/daemon/src", "packages/tui/src"]) {
      out.push({
        name: `${cap} fires in ${dir}`,
        fixture: OVER[cap],
        target: `${dir}/over-${OVER[cap]}`,
        expected: [`eslint(${cap})`],
      });
    }
    out.push({
      name: `${cap} is off in a test file`,
      fixture: OVER[cap],
      target: `packages/engine/src/over-${cap}.test.ts`,
      expected: [],
    });
    const listed = onlyIn(lists, cap);
    out.push({
      name: `${cap} is off for a file on its own list (${listed})`,
      fixture: OVER[cap],
      target: listed,
      expected: [],
    });
    for (const other of CAPS.filter((c) => c !== cap)) {
      out.push({
        name: `${other} still fires for a file listed only for ${cap} (${listed})`,
        fixture: OVER[other],
        target: listed,
        expected: [`eslint(${other})`],
      });
    }
  }
  AT_CAP.forEach((fixture) =>
    out.push({
      name: `${fixture} at the cap passes`,
      fixture,
      target: `packages/engine/src/${fixture}`,
      expected: [],
    }),
  );
  return out;
}

describe("oxlint function size caps", () => {
  it("has one exception list per cap, sorted, naming only files that exist", () => {
    const lists = exceptionLists();
    for (const cap of CAPS) {
      const files = lists[cap];
      expect(files).toEqual(files.toSorted());
      for (const file of files) {
        expect(file).toMatch(/^packages\/[^/]+\/src\//);
        expect(Bun.file(join(REPO, file)).size).toBeGreaterThan(0);
      }
    }
  });

  it(
    "fires each cap outside the exception lists and only for the rule a list names",
    () => {
      // One placement per target path: a run lints each listed path with one fixture at a time.
      const all = cases();
      const rounds: Case[][] = [];
      for (const c of all) {
        const round = rounds.find((r) => !r.some((o) => o.target === c.target));
        if (round) round.push(c);
        else rounds.push([c]);
      }
      for (const round of rounds) {
        const { diagnostics } = lintTree(
          round.map((c) => ({ fixture: c.fixture, target: c.target })),
        );
        for (const c of round) {
          const codes = diagnostics
            .filter((d: Diagnostic) => d.filename === c.target)
            .map((d) => `${d.code}:${d.severity}`);
          expect({ name: c.name, codes }).toEqual({
            name: c.name,
            codes: c.expected.map((code) => `${code}:error`),
          });
        }
        expect(diagnostics.filter((d) => !round.some((c) => c.target === d.filename))).toEqual([]);
      }
    },
    LINT_TIMEOUT_MS,
  );
});
