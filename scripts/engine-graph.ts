// Measures the directory import graph of packages/engine/src (0004, DIPO-381): which engine
// directory imports which, the import cycles between directories, and the back-edges a layer order
// leaves, each with its import-statement count.
//
// A node is a directory of packages/engine/src, a file at its top, or a subdirectory a layer lists
// (`workers/claude-cli`), which then counts apart from its parent. Test files are left out, as
// the `dipo/engine-layers` rule leaves them out. Value imports are read with Bun's own scanner
// (unused imports kept), so they are the imports that rule checks: `import type`, all-`type`
// specifier lists and `typeof import()` are not counted; a dynamic `import()`, a re-export and a
// side-effect import are. Type-only imports are counted apart, for information only.
//
// Usage:
//   bun scripts/engine-graph.ts                 graph, cycles, back-edges of ENGINE_LAYERS
//   bun scripts/engine-graph.ts --layers <x>    back-edges of another order: a JSON file holding
//                                               [["a", "b"], ["c"]] (lowest layer first), or the
//                                               inline form "a,b;c"
//   bun scripts/engine-graph.ts --strict        count an import between two nodes of one layer too
//   bun scripts/engine-graph.ts --suggest       also print a directory order with few back-edges
//   bun scripts/engine-graph.ts --files         list the importing file and line of each back-edge
//   bun scripts/engine-graph.ts --json          print the whole measurement as JSON
//
// `scripts/engine-layers-target.json` holds the layers of 0004 until the lint plugin holds them; the
// moves toward them are measured with `--layers scripts/engine-layers-target.json --strict`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENGINE_SRC = join(ROOT, "packages/engine/src");
const PLUGIN = join(ROOT, "tools/lint/oxlint-plugin.js");

const SOURCE = /\.[cm]?tsx?$/;
const TEST_FILE = /\.test\.[cm]?tsx?$/;

/** One import statement from one engine file into another node. */
export interface ImportSite {
  file: string;
  line: number;
  specifier: string;
}

/** All imports from one node into another. */
export interface Edge {
  from: string;
  to: string;
  /** Value import statements: what the layer rule checks. */
  value: ImportSite[];
  /** Type-only import statements: allowed across layers. */
  types: number;
}

export interface Graph {
  nodes: string[];
  edges: Edge[];
}

/** A layer order: lowest layer first, each layer a list of nodes. */
export type Layers = string[][];

const scanner = new Bun.Transpiler({ loader: "ts", trimUnusedImports: false });

/** Every source file under `dir`, test files left out. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (SOURCE.test(name) && !TEST_FILE.test(name)) out.push(path);
  }
  return out;
}

/**
 * The node a path inside `src` belongs to: the longest of `subdirectories` (layer entries such as
 * `workers/claude-cli`) that holds it, else its first directory, or the top file itself.
 */
export function nodeOf(
  src: string,
  path: string,
  subdirectories: readonly string[] = [],
): string | null {
  const rel = relative(src, path);
  if (rel.startsWith("..") || rel === "") return null;
  const sub = subdirectories
    .filter((entry) => rel === entry || rel.startsWith(`${entry}/`))
    .toSorted((a, b) => b.length - a.length)[0];
  if (sub !== undefined) return sub;
  const first = rel.split("/")[0] ?? rel;
  if (rel.includes("/") || SOURCE.test(first)) return first;
  // `../config` names the directory's index when there is a directory, else the top file.
  return existsSync(join(src, first)) && statSync(join(src, first)).isDirectory()
    ? first
    : `${first}.ts`;
}

/** Specifiers of every import statement, value and type, in the text (comments not stripped). */
const ANY_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(["'])([^"'\n]+)\1/gm;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The import sites of one file, value imports and the count of all imports per specifier. */
function scanFile(path: string): { value: ImportSite[]; all: Map<string, number> } {
  const text = readFileSync(path, "utf8");
  const file = relative(ROOT, path);
  const all = new Map<string, number>();
  const positions = new Map<string, number[]>();
  for (const match of text.matchAll(ANY_IMPORT)) {
    const specifier = match[2] ?? "";
    all.set(specifier, (all.get(specifier) ?? 0) + 1);
    const at = positions.get(specifier) ?? [];
    at.push(lineOf(text, match.index));
    positions.set(specifier, at);
  }
  const value = scanner.scanImports(text).map(({ path: specifier }) => {
    const line = positions.get(specifier)?.shift() ?? 0;
    return { file, line, specifier };
  });
  return { value, all };
}

/**
 * Reads the directory import graph of an engine source folder. `subdirectories` are layer entries
 * below the top (`workers/claude-cli`) that count as nodes of their own.
 */
export function readGraph(src: string = ENGINE_SRC, subdirectories: readonly string[] = []): Graph {
  const nodes = readdirSync(src)
    .filter(
      (name) =>
        statSync(join(src, name)).isDirectory() || (SOURCE.test(name) && !TEST_FILE.test(name)),
    )
    .concat(subdirectories.filter((entry) => existsSync(join(src, entry))))
    .toSorted();
  const edges = new Map<string, Edge>();
  const edgeFor = (from: string, to: string): Edge => {
    const key = `${from}>${to}`;
    let edge = edges.get(key);
    if (edge === undefined) {
      edge = { from, to, value: [], types: 0 };
      edges.set(key, edge);
    }
    return edge;
  };
  const target = (path: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null;
    return nodeOf(src, resolve(dirname(path), specifier), subdirectories);
  };
  for (const path of sourceFiles(src)) {
    const from = nodeOf(src, path, subdirectories);
    if (from === null) continue;
    const { value, all } = scanFile(path);
    const valueCount = new Map<string, number>();
    for (const site of value) {
      const to = target(path, site.specifier);
      if (to === null || to === from) continue;
      edgeFor(from, to).value.push(site);
      valueCount.set(site.specifier, (valueCount.get(site.specifier) ?? 0) + 1);
    }
    for (const [specifier, count] of all) {
      const to = target(path, specifier);
      if (to === null || to === from) continue;
      const types = count - (valueCount.get(specifier) ?? 0);
      if (types > 0) edgeFor(from, to).types += types;
    }
  }
  const list = [...edges.values()].toSorted((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  );
  return { nodes, edges: list };
}

/** The value edges as adjacency, weighted by statement count. */
function adjacency(graph: Graph): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>(graph.nodes.map((n) => [n, new Map()]));
  for (const edge of graph.edges) {
    if (edge.value.length === 0) continue;
    if (!out.has(edge.from)) out.set(edge.from, new Map());
    out.get(edge.from)?.set(edge.to, edge.value.length);
  }
  return out;
}

/** The strongly connected components of the value graph with more than one node (Tarjan). */
export function cycles(graph: Graph): string[][] {
  const adj = adjacency(graph);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  let next = 0;
  const visit = (node: string): void => {
    index.set(node, next);
    low.set(node, next);
    next++;
    stack.push(node);
    onStack.add(node);
    for (const to of adj.get(node)?.keys() ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(to) ?? 0));
      } else if (onStack.has(to)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(to) ?? 0));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    for (;;) {
      const top = stack.pop();
      if (top === undefined) break;
      onStack.delete(top);
      component.push(top);
      if (top === node) break;
    }
    if (component.length > 1) out.push(component.toSorted());
  };
  for (const node of adj.keys()) if (!index.has(node)) visit(node);
  return out.toSorted((a, b) => b.length - a.length);
}

/** The layer index of every node in `layers`. */
function layerIndex(layers: Layers): Map<string, number> {
  const out = new Map<string, number>();
  layers.forEach((layer, i) => {
    for (const node of layer) out.set(node, i);
  });
  return out;
}

/** What a layer order leaves to fix. */
export interface LayerCheck {
  /** Value edges up a layer, and with `strict` also between two nodes of one layer. */
  edges: Edge[];
  /** Nodes of the graph that no layer lists. */
  unplaced: string[];
  /** Layer entries that name no node of the graph. */
  missing: string[];
}

/**
 * The value edges that go from a lower layer up to a higher one. With `strict`, an edge between two
 * nodes of one layer counts too, so the layers hold no cycle at all.
 */
export function backEdges(graph: Graph, layers: Layers, strict = false): LayerCheck {
  const at = layerIndex(layers);
  const unplaced = graph.nodes.filter((node) => !at.has(node));
  const missing = layers.flat().filter((entry) => !graph.nodes.includes(entry));
  const edges = graph.edges.filter((edge) => {
    if (edge.value.length === 0) return false;
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined) return false;
    return to > from || (strict && to === from);
  });
  return { edges, unplaced, missing };
}

/**
 * A node order with few back-edge statements (lowest first), by the greedy heuristic of Eades,
 * Lin and Smyth, weighted by statement count: sinks go to the top, sources to the bottom, and
 * otherwise the node whose imports outweigh its importers most goes to the bottom.
 */
export function suggestOrder(graph: Graph): string[] {
  const adj = adjacency(graph);
  const incoming = new Map<string, Map<string, number>>([...adj.keys()].map((n) => [n, new Map()]));
  for (const [from, tos] of adj) for (const [to, w] of tos) incoming.get(to)?.set(from, w);
  const left = new Set(adj.keys());
  const low: string[] = [];
  const high: string[] = [];
  const weight = (m: Map<string, number> | undefined) =>
    [...(m ?? new Map<string, number>())].reduce((s, [n, w]) => s + (left.has(n) ? w : 0), 0);
  const remove = (node: string) => left.delete(node);
  while (left.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of [...left].toSorted()) {
        // A node that imports nothing left sits below everything left.
        if (weight(adj.get(node)) === 0) {
          low.push(node);
          remove(node);
          changed = true;
        } else if (weight(incoming.get(node)) === 0) {
          high.unshift(node);
          remove(node);
          changed = true;
        }
      }
    }
    if (left.size === 0) break;
    let best = "";
    let bestScore = -Infinity;
    for (const node of [...left].toSorted()) {
      const score = weight(incoming.get(node)) - weight(adj.get(node));
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    low.push(best);
    remove(best);
  }
  return [...low, ...high];
}

/** Parses `--layers`: a JSON file of `string[][]`, or the inline form "a,b;c". */
export function parseLayers(arg: string): Layers {
  if (existsSync(arg)) {
    const parsed: unknown = JSON.parse(readFileSync(arg, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every((l) => Array.isArray(l))) {
      throw new Error(`${arg} holds no list of layers`);
    }
    return parsed.map((layer: unknown[]) => layer.map(String));
  }
  return arg.split(";").map((layer) =>
    layer
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean),
  );
}

/** The layers the lint plugin holds (ENGINE_LAYERS), the one list (0004). */
async function pluginLayers(): Promise<Layers> {
  const plugin: { ENGINE_LAYERS?: Array<{ entries: string[] }> } = await import(PLUGIN);
  if (plugin.ENGINE_LAYERS === undefined)
    throw new Error("the lint plugin exports no ENGINE_LAYERS");
  return plugin.ENGINE_LAYERS.map((layer) => layer.entries);
}

const sum = (edges: Edge[]) => edges.reduce((s, e) => s + e.value.length, 0);

function printReport(graph: Graph, layers: Layers, flags: Set<string>): void {
  const valueEdges = graph.edges.filter((e) => e.value.length > 0);
  console.log(`engine nodes: ${graph.nodes.length}`);
  console.log(`value edges: ${valueEdges.length} (${sum(valueEdges)} import statements)`);
  console.log("\nedges (from -> to: value statements [+ type-only]):");
  for (const edge of graph.edges) {
    const types = edge.types > 0 ? ` [+${edge.types} type]` : "";
    console.log(`  ${edge.from} -> ${edge.to}: ${edge.value.length}${types}`);
  }
  const found = cycles(graph);
  console.log(`\ncycles (strongly connected sets of directories): ${found.length}`);
  for (const component of found) console.log(`  ${component.length}: ${component.join(", ")}`);
  const { edges, unplaced, missing } = backEdges(graph, layers, flags.has("--strict"));
  console.log(`\nlayer order (lowest first):`);
  layers.forEach((layer, i) => console.log(`  ${i}: ${layer.join(", ")}`));
  if (unplaced.length > 0) console.log(`  in no layer: ${unplaced.join(", ")}`);
  if (missing.length > 0) console.log(`  listed but not found: ${missing.join(", ")}`);
  console.log(`\nback-edges: ${edges.length} (${sum(edges)} import statements)`);
  for (const edge of edges) {
    console.log(`  ${edge.from} -> ${edge.to}: ${edge.value.length}`);
    if (!flags.has("--files")) continue;
    for (const site of edge.value) console.log(`      ${site.file}:${site.line} ${site.specifier}`);
  }
  if (flags.has("--suggest")) {
    const order = suggestOrder(graph);
    const suggested = backEdges(
      graph,
      order.map((n) => [n]),
    );
    console.log(
      `\nsuggested order, one node per layer (${suggested.edges.length} back-edges, ${sum(suggested.edges)} statements):`,
    );
    console.log(`  ${order.join(", ")}`);
  }
}

async function main(argv: string[]): Promise<void> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const layersAt = argv.indexOf("--layers");
  const layersArg = layersAt === -1 ? undefined : argv[layersAt + 1];
  const layers = layersArg === undefined ? await pluginLayers() : parseLayers(layersArg);
  const graph = readGraph(
    ENGINE_SRC,
    layers.flat().filter((entry) => entry.includes("/")),
  );
  if (flags.has("--json")) {
    const back = backEdges(graph, layers, flags.has("--strict"));
    console.log(JSON.stringify({ graph, cycles: cycles(graph), layers, backEdges: back }, null, 2));
    return;
  }
  printReport(graph, layers, flags);
}

if (import.meta.main) await main(Bun.argv.slice(2));
