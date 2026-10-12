// Story references in command and read args (0005 section 2). The contract types every reference
// as `StoryRefValue` (a key or a Backlog.md id), so the executor finds them from the args schema
// itself: no handler has to declare them, and the idempotency hash is always taken on keys.

import { type EngineError, StoryRefValue } from "@dipsaus-orchestrator/contract";
import { z } from "zod";

import type { OfficeHandle } from "../db/office";
import { resolveStoryRef, type StoryIdentity } from "../stories/keys";

/** A top-level args field holding one reference or a list of them. */
export interface StoryRefField {
  readonly field: string;
  readonly many: boolean;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let node = schema;
  while (
    node instanceof z.ZodOptional ||
    node instanceof z.ZodDefault ||
    node instanceof z.ZodNullable
  ) {
    node = node.unwrap() as z.ZodType;
  }
  return node;
}

/** The fields of an object args schema typed `StoryRefValue` or an array of it. */
export function findStoryRefFields(args: z.ZodType): StoryRefField[] {
  const root = unwrap(args);
  if (!(root instanceof z.ZodObject)) return [];
  const fields: StoryRefField[] = [];
  for (const [field, schema] of Object.entries(root.shape as Record<string, z.ZodType>)) {
    const node = unwrap(schema);
    if (node === StoryRefValue) {
      fields.push({ field, many: false });
    } else if (node instanceof z.ZodArray && unwrap(node.element as z.ZodType) === StoryRefValue) {
      fields.push({ field, many: true });
    }
  }
  return fields;
}

export type ResolvedArgs =
  | {
      readonly ok: true;
      readonly args: unknown;
      readonly stories: ReadonlyMap<string, StoryIdentity>;
    }
  | { readonly ok: false; readonly error: EngineError };

/**
 * Replaces every story reference in `args` with the story's key. Fails with the first
 * `story.unknown` or `story.ambiguous`. `args` is the parsed value and is not changed.
 */
export function resolveStoryRefs(
  office: OfficeHandle,
  fields: readonly StoryRefField[],
  args: unknown,
): ResolvedArgs {
  const stories = new Map<string, StoryIdentity>();
  if (fields.length === 0 || typeof args !== "object" || args === null) {
    return { ok: true, args, stories };
  }
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  const resolveOne = (ref: unknown): string | EngineError => {
    const resolution = resolveStoryRef(office, String(ref));
    if (!resolution.ok) return resolution.error;
    stories.set(resolution.key, { key: resolution.key, story: resolution.story });
    return resolution.key;
  };
  for (const { field, many } of fields) {
    const value = out[field];
    if (value === undefined) continue;
    if (many && Array.isArray(value)) {
      const keys: string[] = [];
      for (const ref of value) {
        const key = resolveOne(ref);
        if (typeof key !== "string") return { ok: false, error: key };
        keys.push(key);
      }
      out[field] = keys;
    } else {
      const key = resolveOne(value);
      if (typeof key !== "string") return { ok: false, error: key };
      out[field] = key;
    }
  }
  return { ok: true, args: out, stories };
}
