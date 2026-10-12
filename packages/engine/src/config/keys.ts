// Walks configuration schemas and values: key paths, the schema at a path, and a short name for
// the type a schema expects, used in error messages.

import type { z } from "zod";

/** The key segment that stands for any name under a record, as in `scripts.*`. */
export const ANY_KEY = "*";

type Def = { type: string; [key: string]: unknown };

function defOf(schema: z.ZodType): Def {
  return schema.def as unknown as Def;
}

// Strips wrappers that do not change the shape a file writes.
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    const def = defOf(current);
    if (def.type === "optional" || def.type === "default" || def.type === "nullable") {
      current = def["innerType"] as z.ZodType;
    } else {
      return current;
    }
  }
}

function shapeOf(schema: z.ZodType): Record<string, z.ZodType> {
  return (schema as unknown as { shape: Record<string, z.ZodType> }).shape;
}

/**
 * Every leaf key path of a schema, sorted. Objects are descended, a record adds `*`, lists and
 * scalars are leaves.
 */
export function schemaKeyPaths(schema: z.ZodType): string[] {
  const paths: string[] = [];
  const walk = (node: z.ZodType, prefix: string): void => {
    const inner = unwrap(node);
    const def = defOf(inner);
    if (def.type === "object") {
      for (const [key, child] of Object.entries(shapeOf(inner))) {
        walk(child, prefix === "" ? key : `${prefix}.${key}`);
      }
    } else if (def.type === "record") {
      walk(def["valueType"] as z.ZodType, `${prefix}.${ANY_KEY}`);
    } else {
      paths.push(prefix);
    }
  };
  walk(schema, "");
  return paths.toSorted();
}

/** The schema at `path`, or undefined when the path leaves the schema. */
export function schemaAt(schema: z.ZodType, path: readonly PropertyKey[]): z.ZodType | undefined {
  let current: z.ZodType = schema;
  for (const segment of path) {
    const inner = unwrap(current);
    const def = defOf(inner);
    if (def.type === "object") {
      const child = shapeOf(inner)[String(segment)];
      if (child === undefined) return undefined;
      current = child;
    } else if (def.type === "record") {
      current = def["valueType"] as z.ZodType;
    } else if (def.type === "array") {
      current = def["element"] as z.ZodType;
    } else {
      return undefined;
    }
  }
  return current;
}

/** The known keys of the object schema at `path`, or an empty list. */
export function knownKeysAt(schema: z.ZodType, path: readonly PropertyKey[]): string[] {
  const node = schemaAt(schema, path);
  if (node === undefined) return [];
  const inner = unwrap(node);
  return defOf(inner).type === "object" ? Object.keys(shapeOf(inner)) : [];
}

/** A short name for what a schema accepts: `integer`, `string`, `one of "a" | "b"`, ... */
export function describeSchema(schema: z.ZodType): string {
  const inner = unwrap(schema);
  const def = defOf(inner);
  switch (def.type) {
    case "object":
      return "mapping";
    case "record":
      return `mapping of names to ${describeSchema(def["valueType"] as z.ZodType)}`;
    case "array":
      return `list of ${describeSchema(def["element"] as z.ZodType)}`;
    case "number":
      return (inner as unknown as { isInt?: boolean }).isInt === true ? "integer" : "number";
    case "enum":
      return `one of ${Object.values(def["entries"] as Record<string, unknown>)
        .map((value) => JSON.stringify(value))
        .join(" | ")}`;
    case "literal":
      return (def["values"] as unknown[]).map((value) => JSON.stringify(value)).join(" | ");
    default:
      return def.type;
  }
}

/** A short name for the type of a parsed YAML value, for "got ..." in messages. */
export function describeValue(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "object") return "mapping";
  return typeof value;
}

/** True for a plain mapping (not a list, not null). */
export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Leaf key paths of a value: mappings are descended; lists and scalars are leaves. */
export function valueKeyPaths(value: unknown, prefix = ""): string[] {
  if (!isMapping(value)) return prefix === "" ? [] : [prefix];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    paths.push(...valueKeyPaths(child, prefix === "" ? key : `${prefix}.${key}`));
  }
  return paths;
}

/** The value at `path`, or undefined. */
export function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") current = current[segment];
    else if (isMapping(current)) current = current[String(segment)];
    else return undefined;
  }
  return current;
}

/** `a.b.0.c`, or `(top level)` for the empty path. */
export function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "(top level)" : path.map(String).join(".");
}
