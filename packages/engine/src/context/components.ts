// The optional declared component map `.dipo/components.yaml` (0010 section 10, research idea 18).
// Validated on load: names `[a-z0-9-]+`, every `depends_on` exists, no cycles, and each glob
// matches a tracked file or warns. A scope path maps to each component whose globs match the
// path (a file or a new path) or a tracked file under it (a directory).

import { globMatcher, type GlobMatcher } from "../platform/glob";
import { parseYamlDocument } from "../platform/yaml";

export const COMPONENT_MAP_PATH = ".dipo/components.yaml";

const NAME = /^[a-z0-9-]+$/;
const COMPONENT_KEYS = new Set(["paths", "depends_on", "purpose"]);

export interface Component {
  readonly name: string;
  readonly paths: readonly string[];
  readonly dependsOn: readonly string[];
  /** One line saying what the component is for, or null when the map gives none. */
  readonly purpose: string | null;
}

export type ComponentMapResult =
  | { readonly state: "absent" }
  | {
      readonly state: "valid";
      /** Sorted by name. */
      readonly components: readonly Component[];
      readonly warnings: readonly string[];
    }
  | {
      readonly state: "invalid";
      readonly errors: readonly string[];
      readonly warnings: readonly string[];
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry !== "");

function parseComponent(name: string, value: unknown, errors: string[]): Component | undefined {
  if (!NAME.test(name)) {
    errors.push(`component "${name}": names use only a-z, 0-9 and "-"`);
  }
  if (!isRecord(value)) {
    errors.push(`component "${name}": expected a mapping with \`paths\``);
    return undefined;
  }
  for (const key of Object.keys(value).toSorted()) {
    if (!COMPONENT_KEYS.has(key)) errors.push(`component "${name}": unknown key \`${key}\``);
  }
  const { paths, depends_on: dependsOn, purpose } = value;
  let ok = true;
  if (!isStringList(paths) || paths.length === 0) {
    errors.push(`component "${name}": \`paths\` must be a non-empty list of globs`);
    ok = false;
  }
  if (dependsOn !== undefined && !isStringList(dependsOn)) {
    errors.push(`component "${name}": \`depends_on\` must be a list of component names`);
    ok = false;
  }
  if (purpose !== undefined && typeof purpose !== "string") {
    errors.push(`component "${name}": \`purpose\` must be a string`);
    ok = false;
  }
  if (!ok) return undefined;
  return {
    name,
    paths: paths as string[],
    dependsOn: [...new Set((dependsOn as string[] | undefined) ?? [])].toSorted(),
    purpose: typeof purpose === "string" ? (purpose.split("\n")[0]?.trim() ?? "") || null : null,
  };
}

/** Each cycle once, as `a -> b -> a`, starting at its smallest name. */
function findCycles(components: readonly Component[]): string[] {
  const byName = new Map(components.map((component) => [component.name, component]));
  const state = new Map<string, "open" | "done">();
  const seen = new Set<string>();
  const cycles: string[] = [];
  const stack: string[] = [];
  const visit = (name: string): void => {
    state.set(name, "open");
    stack.push(name);
    for (const next of byName.get(name)?.dependsOn ?? []) {
      if (!byName.has(next)) continue;
      const mark = state.get(next);
      if (mark === "open") {
        const loop = stack.slice(stack.indexOf(next));
        const start = loop.indexOf(loop.toSorted()[0] as string);
        const rotated = [...loop.slice(start), ...loop.slice(0, start)];
        const key = rotated.join(" -> ");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(`${key} -> ${rotated[0]}`);
        }
      } else if (mark === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(name, "done");
  };
  for (const component of components) {
    if (!state.has(component.name)) visit(component.name);
  }
  return cycles.toSorted();
}

/**
 * Validates the text of `.dipo/components.yaml` against the tracked files. Never throws; errors
 * make the map invalid, warnings (globs that match no tracked file) do not.
 */
export function validateComponentMap(
  text: string,
  tracked: readonly string[],
): Exclude<ComponentMapResult, { state: "absent" }> {
  const parsed = parseYamlDocument(text);
  if (!parsed.ok) {
    return { state: "invalid", errors: [`${COMPONENT_MAP_PATH}: ${parsed.message}`], warnings: [] };
  }
  const errors: string[] = [];
  const root = parsed.value;
  if (!isRecord(root) || !isRecord(root["components"])) {
    return {
      state: "invalid",
      errors: [`${COMPONENT_MAP_PATH}: expected a mapping with \`components\``],
      warnings: [],
    };
  }
  for (const key of Object.keys(root).toSorted()) {
    if (key !== "components") errors.push(`${COMPONENT_MAP_PATH}: unknown key \`${key}\``);
  }
  const components: Component[] = [];
  const declared = root["components"];
  for (const name of Object.keys(declared).toSorted()) {
    const component = parseComponent(name, declared[name], errors);
    if (component !== undefined) components.push(component);
  }
  const names = new Set(Object.keys(declared));
  for (const component of components) {
    for (const dependency of component.dependsOn) {
      if (!names.has(dependency)) {
        errors.push(`component "${component.name}": depends_on "${dependency}" does not exist`);
      }
    }
  }
  for (const cycle of findCycles(components)) {
    errors.push(`components depend on each other in a cycle: ${cycle}`);
  }
  const warnings: string[] = [];
  for (const component of components) {
    for (const pattern of component.paths) {
      const match = globMatcher(pattern);
      if (!tracked.some((path) => match(path))) {
        warnings.push(`component "${component.name}": glob "${pattern}" matches no tracked file`);
      }
    }
  }
  if (errors.length > 0) return { state: "invalid", errors, warnings };
  return { state: "valid", components, warnings };
}

/** How a scope path exists in the checkout. */
export type ScopeKind =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "dir"; readonly path: string; readonly files: readonly string[] }
  | { readonly kind: "new"; readonly path: string };

export type ComponentVia = "scope" | "depends-on" | "depended-on-by";

export interface ComponentMatch {
  readonly component: Component;
  readonly via: ComponentVia;
}

function matchersOf(component: Component): GlobMatcher[] {
  return component.paths.map((pattern) => globMatcher(pattern));
}

/**
 * The components whose globs match the scope, plus `extra` names already matched by the engine,
 * then their direct neighbours both ways: what they depend on and what depends on them. Matched
 * components come first, each group sorted by name.
 */
export function matchComponents(
  components: readonly Component[],
  scope: readonly ScopeKind[],
  extra: readonly string[] = [],
): ComponentMatch[] {
  const matched = new Set<string>(extra.filter((name) => components.some((c) => c.name === name)));
  for (const component of components) {
    const matchers = matchersOf(component);
    const hits = (path: string) => matchers.some((match) => match(path));
    for (const entry of scope) {
      const found = entry.kind === "dir" ? entry.files.some(hits) : hits(entry.path);
      if (found) {
        matched.add(component.name);
        break;
      }
    }
  }
  const neighbours = new Map<string, ComponentVia>();
  for (const component of components) {
    if (!matched.has(component.name)) continue;
    for (const dependency of component.dependsOn) {
      if (!matched.has(dependency) && !neighbours.has(dependency)) {
        neighbours.set(dependency, "depends-on");
      }
    }
  }
  for (const component of components) {
    if (matched.has(component.name) || neighbours.has(component.name)) continue;
    if (component.dependsOn.some((dependency) => matched.has(dependency))) {
      neighbours.set(component.name, "depended-on-by");
    }
  }
  const byName = (a: ComponentMatch, b: ComponentMatch) =>
    a.component.name < b.component.name ? -1 : a.component.name > b.component.name ? 1 : 0;
  const first = components
    .filter((component) => matched.has(component.name))
    .map((component): ComponentMatch => ({ component, via: "scope" }))
    .toSorted(byName);
  const second = components
    .filter((component) => neighbours.has(component.name))
    .map((component): ComponentMatch => ({
      component,
      via: neighbours.get(component.name) as ComponentVia,
    }))
    .toSorted(byName);
  return [...first, ...second];
}

/** Tracked files that any of the component's globs match, sorted. */
export function componentFiles(component: Component, tracked: readonly string[]): string[] {
  const matchers = matchersOf(component);
  return tracked.filter((path) => matchers.some((match) => match(path))).toSorted();
}
