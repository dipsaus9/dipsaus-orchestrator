// Story references in command and read args (0005 section 2). The contract types every reference
// as `StoryRefValue` (a key or a Backlog.md id), so the executor finds them from the args schema
// itself: no handler has to declare them, and the idempotency hash is always taken on keys.

import { type EngineError, StoryRefValue } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { resolveStoryRef, type StoryIdentity } from "../stories/keys";

/** A top-level args field holding one reference or a list of them. */
export interface StoryRefField {
  readonly field: string;
  readonly many: boolean;
}

// The part of a zod schema read here: its public `def`.
interface SchemaNode {
  def: {
    type: string;
    innerType?: SchemaNode;
    element?: SchemaNode;
    shape?: Readonly<Record<string, SchemaNode>>;
  };
}

function unwrap(schema: SchemaNode): SchemaNode {
  let node = schema;
  for (
    let def = node.def;
    (def.type === "optional" || def.type === "default" || def.type === "nullable") &&
    def.innerType !== undefined;
    def = node.def
  ) {
    node = def.innerType;
  }
  return node;
}

const STORY_REF = StoryRefValue as unknown as SchemaNode;

/** The fields of an object args schema typed `StoryRefValue` or an array of it. */
export function findStoryRefFields(args: unknown): StoryRefField[] {
  const root = unwrap(args as SchemaNode);
  const shape = root.def.type === "object" ? root.def.shape : undefined;
  if (shape === undefined) return [];
  const fields: StoryRefField[] = [];
  for (const [field, schema] of Object.entries(shape)) {
    const node = unwrap(schema);
    if (node === STORY_REF) {
      fields.push({ field, many: false });
    } else if (node.def.type === "array" && node.def.element !== undefined) {
      if (unwrap(node.def.element) === STORY_REF) fields.push({ field, many: true });
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
