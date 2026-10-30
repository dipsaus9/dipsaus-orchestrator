import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { backEdges, cycles, parseLayers, readGraph, suggestOrder } from "./engine-graph";

// Temp files only under DIPO_TMP (0017), falling back to /tmp.
const TMP_ROOT = process.env["DIPO_TMP"] || "/tmp";
const src = mkdtempSync(join(TMP_ROOT, "engine-graph-"));
afterAll(() => rmSync(src, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(dirname(join(src, path)), { recursive: true });
  writeFileSync(join(src, path), text);
}

// a -> b (value), b -> a (type only), b <-> c (values), box <-> workers through the adapter.
write("a/x.ts", 'import { y } from "../b/y";\nexport const x = y;\n');
write("b/y.ts", 'import type { X } from "../a/x";\nexport const y = 1;\nexport type Y = X;\n');
write("b/z.ts", 'import { w } from "../c/w";\nexport const z = w;\n');
write("b/z.test.ts", 'import { x } from "../a/x";\nexport const t = x;\n');
write("c/w.ts", 'export { y as w } from "../b/y";\nexport const lazy = () => import("../b/z");\n');
write("workers/hold.ts", "export const hold = 1;\n");
write("workers/claude-cli/adapter.ts", 'import { q } from "../../box/q";\nexport const a = q;\n');
write("box/q.ts", 'import { hold } from "../workers/hold";\nexport const q = hold;\n');
write("index.ts", 'import { x } from "./a/x";\nexport { x };\n');

const edge = (graph: ReturnType<typeof readGraph>, from: string, to: string) =>
  graph.edges.find((e) => e.from === from && e.to === to);

describe("the engine import graph (DIPO-381)", () => {
  it("counts value imports per directory, type-only imports apart, and leaves tests out", () => {
    const graph = readGraph(src);
    expect(graph.nodes).toEqual(["a", "b", "box", "c", "index.ts", "workers"]);
    expect(edge(graph, "a", "b")?.value.length).toBe(1);
    expect(edge(graph, "b", "a")).toEqual({ from: "b", to: "a", value: [], types: 1 });
    // A re-export and a dynamic import are value imports.
    expect(edge(graph, "c", "b")?.value.length).toBe(2);
    expect(edge(graph, "index.ts", "a")?.value[0]?.line).toBe(1);
  });

  it("finds the cycles between directories, and a listed subdirectory counts apart", () => {
    expect(cycles(readGraph(src))).toEqual([
      ["b", "c"],
      ["box", "workers"],
    ]);
    const split = readGraph(src, ["workers/claude-cli"]);
    expect(split.nodes).toContain("workers/claude-cli");
    expect(cycles(split)).toEqual([["b", "c"]]);
  });

  it("lists the value edges up a layer, and with strict those inside one layer", () => {
    const graph = readGraph(src, ["workers/claude-cli"]);
    const layers = parseLayers("workers;box;workers/claude-cli;c;b,a;index.ts,missing");
    const loose = backEdges(graph, layers);
    expect(loose.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["c>b"]);
    expect(loose.unplaced).toEqual([]);
    expect(loose.missing).toEqual(["missing"]);
    const strict = backEdges(graph, layers, true);
    expect(strict.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["a>b", "c>b"]);
  });

  it("suggests an order that leaves only the edges a cycle forces", () => {
    const graph = readGraph(src, ["workers/claude-cli"]);
    const order = suggestOrder(graph);
    expect(order.toSorted()).toEqual(graph.nodes.toSorted());
    expect(
      backEdges(
        graph,
        order.map((node) => [node]),
      ).edges,
    ).toHaveLength(1);
  });
});
