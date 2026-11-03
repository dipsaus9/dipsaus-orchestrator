// Pack bytes (0014). The same pack always encodes to the same bytes: object keys sorted, no
// timestamps. Nothing about a pack is stored; it is built again whenever a task message is built.

import { createHash } from "node:crypto";

import type { ContextPack } from "./types";

/**
 * The git blob id of `bytes`, as `git hash-object --no-filters` gives it. The provider hashes the
 * raw work-tree bytes it read, so for a file with clean filters, `text`/`eol` attributes or
 * `core.autocrlf` the id can differ from the index id `git ls-files -s` shows. That is fine for
 * staleness: the same work-tree bytes always give the same id.
 */
export function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Canonical JSON of a pack: sorted keys, no whitespace. */
export function encodePack(pack: ContextPack): string {
  return JSON.stringify(canonical(pack));
}

/** sha256 of the encoded pack, hex. */
export function packDigest(pack: ContextPack): string {
  return createHash("sha256").update(encodePack(pack)).digest("hex");
}
