// Measures the directory import graph of packages/engine/src (0004, DIPO-381): which engine
// directory imports which, the import cycles between directories, and the back-edges a layer order
// leaves (a value import into a higher layer), each with its import-statement count. 0004 allows an
// import between two directories of one layer as long as it closes no cycle, so the cycles are the
// other half of the check.
//
// A node is a directory of packages/engine/src, a file at its top, or a subdirectory a layer lists
// (`workers/claude-cli`), which then counts apart from its parent. Test files are left out, as
// the `dipo/engine-layers` rule leaves them out. Value imports are read with Bun's own scanner
// (unused imports kept), so they are the imports that rule checks: `import type`, all-`type`
// specifier lists and `typeof import()` are not counted; a dynamic `import()`, a re-export and a
// side-effect import are, and so is `import.meta.require`, which the scanner leaves out. Type-only
// imports are counted apart, for information only. Commented-out imports count nowhere.
//
// Usage:
//   bun scripts/engine-graph.ts                 graph, cycles, back-edges of ENGINE_LAYERS
//   bun scripts/engine-graph.ts --layers <x>    back-edges of another order to try, "a,b;c"
//                                               (lowest layer first)
//   bun scripts/engine-graph.ts --check         exit 1 when a back-edge, a directory cycle, a
//                                               node in no layer or an entry naming no node is left
//   bun scripts/engine-graph.ts --suggest       also print a directory order with few back-edges
//   bun scripts/engine-graph.ts --files         list the importing file and line of each back-edge
//   bun scripts/engine-graph.ts --json          print the whole measurement as JSON
//
// The layers are ENGINE_LAYERS of the lint plugin, the one list (0004). `dipo/engine-layers` refuses
// a back-edge where it is written; the cycle check here is the other half, and
// `test/lint-boundaries/lint-engine-layers.test.ts` runs it (`checkEngine`) in `bun run verify`.

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

/** `text` with every comment blanked out, line breaks kept, so a commented import counts nowhere. */
export function withoutComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote !== null) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const stop = close === -1 ? text.length : close + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else out += c;
  }
  return out;
}

/** One import statement found in a file's text: its specifier, line and whether it is type-only. */
interface FoundImport {
  specifier: string;
  line: number;
  typeOnly: boolean;
  /** `import.meta.require(x)`, which Bun's scanner does not report. */
  metaRequire: boolean;
}

/** `import ... from` and `export ... from`: 1 `type`, 2 the specifier list, 4 the specifier. */
const STATIC_FORM = /\b(?:import|export)\s+(type\s+)?([^;"'`]*?)\s*from\s*(["'])([^"'\n]+)\3/g;
/** `import "x"`, `import(x)`, `typeof import(x)`, `require(x)`, `import.meta.require(x)`: 1 `typeof`, 4 the specifier. */
const CALL_FORM =
  /(typeof\s+)?\b(import\.meta\.require\s*\(\s*|import\s*\(\s*|import\s+|require\s*\(\s*)(["'])([^"'\n]+)\3/g;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** True when a specifier list such as `{ type A, type B }` names only types. */
function allTypes(list: string): boolean {
  const braces = /^\{([^}]*)\}$/.exec(list.trim());
  if (braces === null) return false;
  const names = (braces[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => name.startsWith("type "));
}

/** Every import statement in a file's text, comments left out, in text order. */
export function findImports(source: string): FoundImport[] {
  const text = withoutComments(source);
  const found: Array<FoundImport & { at: number }> = [];
  for (const match of text.matchAll(STATIC_FORM)) {
    const typeOnly = match[1] !== undefined || allTypes(match[2] ?? "");
    found.push({
      specifier: match[4] ?? "",
      line: lineOf(text, match.index),
      typeOnly,
      metaRequire: false,
      at: match.index,
    });
  }
  for (const match of text.matchAll(CALL_FORM)) {
    found.push({
      specifier: match[4] ?? "",
      line: lineOf(text, match.index),
      typeOnly: match[1] !== undefined,
      metaRequire: (match[2] ?? "").startsWith("import.meta"),
      at: match.index,
    });
  }
  return found.toSorted((x, y) => x.at - y.at).map(({ at: _at, ...site }) => site);
}

/**
 * The import sites of one file: its value imports, as Bun's scanner reads them plus
 * `import.meta.require` (which the scanner leaves out and the lint rule counts), each with the line
 * of its own statement, and its type-only imports.
 */
function scanFile(path: string): { value: ImportSite[]; types: string[] } {
  const text = readFileSync(path, "utf8");
  const file = relative(ROOT, path);
  const found = findImports(text);
  const lines = new Map<string, number[]>();
  for (const site of found) {
    if (site.typeOnly) continue;
    lines.set(site.specifier, [...(lines.get(site.specifier) ?? []), site.line]);
  }
  const scanned = scanner.scanImports(text).map(({ path: specifier }) => specifier);
  const metaRequires = found.filter((site) => site.metaRequire).map((site) => site.specifier);
  const value = [...scanned, ...metaRequires].map((specifier) => {
    const line = lines.get(specifier)?.shift() ?? 0;
    return { file, line, specifier };
  });
  const types = found.filter((site) => site.typeOnly).map((site) => site.specifier);
  return { value, types };
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
    const { value, types } = scanFile(path);
    for (const site of value) {
      const to = target(path, site.specifier);
      if (to !== null && to !== from) edgeFor(from, to).value.push(site);
    }
    for (const specifier of types) {
      const to = target(path, specifier);
      if (to !== null && to !== from) edgeFor(from, to).types += 1;
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
  /** Value edges into a higher layer. */
  edges: Edge[];
  /** Nodes of the graph that no layer lists. */
  unplaced: string[];
  /** Layer entries that name no node of the graph. */
  missing: string[];
}

/**
 * The value edges that go from a lower layer up to a higher one. An edge inside one layer is no
 * back-edge; a cycle it closes shows in `cycles`.
 */
export function backEdges(graph: Graph, layers: Layers): LayerCheck {
  const at = layerIndex(layers);
  const unplaced = graph.nodes.filter((node) => !at.has(node));
  const missing = layers.flat().filter((entry) => !graph.nodes.includes(entry));
  const edges = graph.edges.filter((edge) => {
    if (edge.value.length === 0) return false;
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined) return false;
    return to > from;
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

/** Parses `--layers`, the inline form "a,b;c" (lowest layer first). */
export function parseLayers(arg: string): Layers {
  return arg.split(";").map((layer) =>
    layer
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean),
  );
}

/** One layer of the lint plugin's ENGINE_LAYERS: the band of 0004 it sits in, and its entries. */
export interface EngineLayer {
  band: number;
  entries: string[];
}

/** The layers the lint plugin holds (ENGINE_LAYERS), the one list (0004). */
export async function engineLayers(): Promise<EngineLayer[]> {
  const plugin: { ENGINE_LAYERS?: EngineLayer[] } = await import(PLUGIN);
  if (plugin.ENGINE_LAYERS === undefined)
    throw new Error("the lint plugin exports no ENGINE_LAYERS");
  return plugin.ENGINE_LAYERS;
}

/** What the check finds: the back-edges and placement of a layer order, and the directory cycles. */
export interface EngineCheck extends LayerCheck {
  cycles: string[][];
}

/** Checks a graph against a layer order. */
export function checkGraph(graph: Graph, layers: Layers): EngineCheck {
  return { ...backEdges(graph, layers), cycles: cycles(graph) };
}

/** The entries of `layers` below the top of the engine, which count apart from their parents. */
function subdirectoriesOf(layers: Layers): string[] {
  return layers.flat().filter((entry) => entry.includes("/"));
}

/** Reads the engine sources at `src` and checks them against `layers`: the check `--check` runs. */
export function checkEngine(src: string, layers: Layers): EngineCheck {
  return checkGraph(readGraph(src, subdirectoriesOf(layers)), layers);
}

/** How many problems a check found; `--check` fails on any. */
export function problemsOf(check: EngineCheck): number {
  return check.edges.length + check.cycles.length + check.unplaced.length + check.missing.length;
}

const sum = (edges: Edge[]) => edges.reduce((s, e) => s + e.value.length, 0);

/** Prints the measurement; returns the number of problems the check found. */
function printReport(graph: Graph, layers: Layers, flags: Set<string>): number {
  const valueEdges = graph.edges.filter((e) => e.value.length > 0);
  console.log(`engine nodes: ${graph.nodes.length}`);
  console.log(`value edges: ${valueEdges.length} (${sum(valueEdges)} import statements)`);
  console.log("\nedges (from -> to: value statements [+ type-only]):");
  for (const edge of graph.edges) {
    const types = edge.types > 0 ? ` [+${edge.types} type]` : "";
    console.log(`  ${edge.from} -> ${edge.to}: ${edge.value.length}${types}`);
  }
  const check = checkGraph(graph, layers);
  const { edges, unplaced, missing, cycles: found } = check;
  console.log(`\ncycles (strongly connected sets of directories): ${found.length}`);
  for (const component of found) console.log(`  ${component.length}: ${component.join(", ")}`);
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
  const placement =
    unplaced.length + missing.length > 0
      ? `, ${unplaced.length} in no layer, ${missing.length} listed but not found`
      : "";
  console.log(`\nresult: ${edges.length} back-edges, ${found.length} cycles${placement}`);
  return problemsOf(check);
}

async function main(argv: string[]): Promise<void> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const layersAt = argv.indexOf("--layers");
  const layersArg = layersAt === -1 ? undefined : argv[layersAt + 1];
  const layers =
    layersArg === undefined
      ? (await engineLayers()).map((layer) => layer.entries)
      : parseLayers(layersArg);
  const graph = readGraph(ENGINE_SRC, subdirectoriesOf(layers));
  if (flags.has("--json")) {
    const back = backEdges(graph, layers);
    console.log(JSON.stringify({ graph, cycles: cycles(graph), layers, backEdges: back }, null, 2));
    return;
  }
  const problems = printReport(graph, layers, flags);
  if (flags.has("--check") && problems > 0) process.exitCode = 1;
}

if (import.meta.main) await main(Bun.argv.slice(2));
