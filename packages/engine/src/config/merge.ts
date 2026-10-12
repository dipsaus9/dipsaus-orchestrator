// Layer merging and the configuration hash (0017 section 5, 0007).

import { createHash } from "node:crypto";

import { isMapping } from "./keys";

/**
 * Merges `over` onto `base`: mappings merge per key, lists and scalars replace, and an absent or
 * `undefined` key keeps the base value. Neither input is changed.
 */
export function mergeLayer(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isMapping(base) || !isMapping(over)) return over;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    result[key] = mergeLayer(base[key], value);
  }
  return result;
}

/** JSON with mapping keys sorted at every level and `undefined` keys left out. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isMapping(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    if (value[key] !== undefined) sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

/** sha256, hex, over the canonical JSON of an effective configuration. */
export function configHash(config: unknown): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}
