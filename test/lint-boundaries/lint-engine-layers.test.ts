// Asserts the engine's layers (0004, DIPO-395). `dipo/engine-layers` refuses a value import into a
// higher layer of ENGINE_LAYERS, the one list in the lint plugin, in every runtime form, and
// reports a directory in no layer; a value import inside one layer and every type-only import pass.
// Each layer sits in one band of 0004's table, in band order. The directory cycle check of
// `scripts/engine-graph.ts`, which reads the same list, refuses the cycle such an import inside one
// layer can close. The repository's own engine passes the rule (in `bun run lint`) and the cycle
// check (here), with no exception.

import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import {
  checkEngine,
  engineLayers,
  problemsOf,
  type EngineLayer,
} from "../../scripts/engine-graph";
import { LINT_TIMEOUT_MS, lintTree, type Diagnostic, type Written } from "./lint-tree";

const RULE = "dipo(engine-layers)";
const FILE_CYCLE = "import(no-cycle)";
const ENGINE = "packages/engine/src";
const REPO = join(import.meta.dir, "..", "..");
const FIXTURES = join(import.meta.dir, "fixtures");

const LAYERS: EngineLayer[] = await engineLayers();
const ORDER = LAYERS.map((layer) => layer.entries);

const hitsIn = (diagnostics: Diagnostic[], target: string, code = RULE) =>
  diagnostics.filter((d) => d.code === code && d.filename === target);

/** Where a file of `entry` goes: a directory entry gets a file of its own; a top file is itself. */
function fileOf(entry: string, name: string): string {
  return entry.endsWith(".ts") ? `${ENGINE}/${entry}` : `${ENGINE}/${entry}/${name}.ts`;
}

/** A file of `from` with one value import of a module of `to`. */
function importing(from: string, to: string, name: string): Written {
  const target = fileOf(from, name);
  const module = to.endsWith(".ts") ? `${ENGINE}/${to.slice(0, -3)}` : `${ENGINE}/${to}/target`;
  const path = relative(dirname(target), module);
  const specifier = path.startsWith(".") ? path : `./${path}`;
  return { target, text: `import { value } from "${specifier}";\n\nexport const used = value;\n` };
}

/** The directories of each band of 0004's table, read from the ADR itself. */
function adrBands(): Map<string, number> {
  const adr = readFileSync(join(REPO, "docs/decisions/0004-language-and-runtime.md"), "utf8");
  const bands = new Map<string, number>();
  for (const row of adr.matchAll(/^\| (\d)\. [^|]+\| ([^|]+) \|/gm)) {
    for (const name of (row[2] ?? "").matchAll(/`([^`]+)`/g))
      bands.set(name[1] ?? "", Number(row[1]));
  }
  return bands;
}

describe("the engine's layer list", () => {
  it("puts every directory of a band of 0004 in a layer of that band, in band order", () => {
    const bands = adrBands();
    expect(bands.size).toBeGreaterThan(40);
    expect(LAYERS.flatMap((layer) => layer.entries).toSorted()).toEqual(
      [...bands.keys()].toSorted(),
    );
    for (const layer of LAYERS) {
      for (const entry of layer.entries)
        expect([entry, bands.get(entry)]).toEqual([entry, layer.band]);
    }
    const order = LAYERS.map((layer) => layer.band);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });
});

describe("the engine's layers", () => {
  it(
    "refuses a value import up every boundary between adjacent layers",
    () => {
      const placements = LAYERS.slice(0, -1).flatMap((layer, i) =>
        layer.entries.map((entry) => importing(entry, LAYERS[i + 1]?.entries[0] ?? "", "up")),
      );
      const { diagnostics } = lintTree(placements);
      for (const { target } of placements) {
        expect([target, hitsIn(diagnostics, target).length]).toEqual([target, 1]);
      }
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "lets the same import down every boundary between adjacent layers pass",
    () => {
      const placements = LAYERS.slice(1).flatMap((layer, i) =>
        layer.entries.map((entry) => importing(entry, LAYERS[i]?.entries[0] ?? "", "down")),
      );
      const { diagnostics } = lintTree(placements);
      expect(diagnostics.filter((d) => d.code === RULE)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "refuses every import form up a layer and lets the type-only forms cross",
    () => {
      const target = `${ENGINE}/gate/forms.ts`;
      const { diagnostics } = lintTree([{ fixture: "layers-up-forms.ts", target }]);
      // Static, `export ... from`, `export * from`, the barrel, a side-effect import, `import()`,
      // `require`, `import.meta.require` and `import x = require()`; none of the four type forms.
      expect(hitsIn(diagnostics, target).length).toBe(9);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "lets a value import between two entries of one layer and a type-only import up a layer pass",
    () => {
      const target = `${ENGINE}/commands/inside.ts`;
      const { diagnostics } = lintTree([{ fixture: "layers-inside.ts", target }]);
      expect(hitsIn(diagnostics, target)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "places a file under workers/claude-cli in its own layer, not in workers",
    () => {
      const adapter = `${ENGINE}/workers/claude-cli/layers.ts`;
      const worker = `${ENGINE}/workers/layers.ts`;
      const { diagnostics } = lintTree([
        { fixture: "layers-adapter.ts", target: adapter },
        { fixture: "layers-workers.ts", target: worker },
      ]);
      // The adapter may import box (a lower layer) but not worktree (a higher one); workers may
      // import neither.
      const adapterHits = hitsIn(diagnostics, adapter);
      expect(adapterHits.length).toBe(1);
      expect(adapterHits[0]?.message).toContain("workers/claude-cli may not import worktree");
      expect(hitsIn(diagnostics, worker).length).toBe(2);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "refuses a value import from the platform up a layer, and a directory in no layer",
    () => {
      const { diagnostics } = lintTree([
        { fixture: "layers-up.ts", target: `${ENGINE}/platform/up.ts` },
        { fixture: "layers-down.ts", target: `${ENGINE}/unlisted/down.ts` },
      ]);
      // The run import and the dynamic import of the composition root; not the type, not the
      // platform's own import.
      expect(hitsIn(diagnostics, `${ENGINE}/platform/up.ts`).length).toBe(2);
      expect(hitsIn(diagnostics, `${ENGINE}/unlisted/down.ts`).length).toBe(1);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "lets the services and the composition root import down and inside their layer",
    () => {
      const { diagnostics } = lintTree([
        { fixture: "layers-down.ts", target: `${ENGINE}/merge/down.ts` },
        { fixture: "layers-down.ts", target: `${ENGINE}/create/down.ts` },
      ]);
      expect(diagnostics.filter((d) => d.code === RULE)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});

// Temp files only under DIPO_TMP (0017), falling back to /tmp.
const TMP_ROOT = process.env["DIPO_TMP"] || "/tmp";
mkdirSync(TMP_ROOT, { recursive: true });
const tree = mkdtempSync(join(TMP_ROOT, "engine-cycle-"));
afterAll(() => rmSync(tree, { recursive: true, force: true }));

/** Two directories of one layer that import each other through different files: no file cycle. */
const CYCLE = [
  { fixture: "layers-cycle-commands.ts", target: `${ENGINE}/commands/cycle.ts` },
  { fixture: "layers-leaf.ts", target: `${ENGINE}/commands/leaf.ts` },
  { fixture: "layers-cycle-views.ts", target: `${ENGINE}/views/cycle.ts` },
  { fixture: "layers-leaf.ts", target: `${ENGINE}/views/leaf.ts` },
];

describe("the engine's directory cycle check", () => {
  it("passes on the repository's engine: no back-edge, no cycle, no directory in no layer", () => {
    const check = checkEngine(join(REPO, ENGINE), ORDER);
    expect(check.cycles).toEqual([]);
    expect(check.edges).toEqual([]);
    expect(check.unplaced).toEqual([]);
    expect(check.missing).toEqual([]);
  });

  it("refuses two directories of one layer that import each other", () => {
    for (const { fixture, target } of CYCLE) {
      const path = join(tree, target);
      mkdirSync(dirname(path), { recursive: true });
      cpSync(join(FIXTURES, fixture), path);
    }
    const check = checkEngine(join(tree, ENGINE), ORDER);
    expect(check.cycles).toEqual([["commands", "views"]]);
    expect(check.edges).toEqual([]);
    expect(problemsOf(check)).toBeGreaterThan(0);
  });

  it(
    "is the only check that refuses that cycle: the layer rule and the file cycle rule let it pass",
    () => {
      const { diagnostics } = lintTree(CYCLE);
      expect(diagnostics.filter((d) => d.code === RULE || d.code === FILE_CYCLE)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
