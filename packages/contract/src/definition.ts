// How the contract defines its commands, reads and events, and how `commands.describe` renders
// them. A command or read carries `since` (the contract minor it shipped in) or, while no engine
// has built it, `provisional: true` (0005 section 11, amendment of 2026-10-12).

import { z } from "zod";

import { CONTRACT_VERSION } from "./version";

export type Versioning =
  | { since: number; provisional?: never }
  | { provisional: true; since?: never };

// `software`: the envelope omits `office` and the args name one. `office`: the envelope carries it.
export type CommandLevel = "software" | "office";

export type CommandDefinition<
  N extends string = string,
  A extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> = {
  name: N;
  level: CommandLevel;
  args: A;
  result: R;
  confirm: boolean; // every client asks before sending
  irreversible: boolean; // clients ask for typed confirmation (0009 section 5)
} & Versioning;

export type ReadDefinition<
  N extends string = string,
  A extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> = { name: N; args: A; result: R } & Versioning;

export type EventStream = "software" | "office" | "both";

export type EventDefinition<T extends string = string, D extends z.ZodType = z.ZodType> = {
  type: T;
  stream: EventStream;
  derived: boolean; // not a stored fact: never consumes a seq and is not replayed
  data: D;
};

export function defineCommand<const N extends string, A extends z.ZodType, R extends z.ZodType>(
  definition: CommandDefinition<N, A, R>,
): CommandDefinition<N, A, R> {
  return definition;
}

export function defineRead<const N extends string, A extends z.ZodType, R extends z.ZodType>(
  definition: ReadDefinition<N, A, R>,
): ReadDefinition<N, A, R> {
  return definition;
}

export function defineEvent<const T extends string, D extends z.ZodType>(
  definition: EventDefinition<T, D>,
): EventDefinition<T, D> {
  return definition;
}

// Runtime check of the versioning rule, for definitions the type system did not see. Returns the
// problem, or undefined when the definition is valid.
export function checkVersioning(definition: object): string | undefined {
  const { since, provisional } = definition as { since?: unknown; provisional?: unknown };
  if (since !== undefined && provisional !== undefined) {
    return "carries both since and provisional";
  }
  if (provisional !== undefined) {
    return provisional === true ? undefined : "provisional must be true when present";
  }
  if (since === undefined) return "carries neither since nor provisional";
  if (typeof since !== "number" || !Number.isInteger(since) || since < 0) {
    return "since must be a contract minor (a non-negative integer)";
  }
  if (since > CONTRACT_VERSION.minor) {
    return `since ${since} is newer than contract minor ${CONTRACT_VERSION.minor}`;
  }
  return undefined;
}

export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

export const ReadDescription = z.object({
  name: z.string(),
  args: JsonSchema,
  result: JsonSchema,
  since: z.int().nonnegative(),
});
export type ReadDescription = z.infer<typeof ReadDescription>;

export const CommandDescription = z.object({
  ...ReadDescription.shape,
  level: z.enum(["software", "office"]),
  confirm: z.boolean(),
  irreversible: z.boolean(),
});
export type CommandDescription = z.infer<typeof CommandDescription>;

// JSON Schema of one zod schema without the per-document `$schema` keyword. Always the input side:
// zod's output side adds `additionalProperties: false` to every object, which would make a reader
// of another language reject the fields a newer minor adds (0005 section 11). A field with a
// default is optional on this side.
export function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
}

// A provisional definition has no `since` and is never described (0005 section 11).
export function describeCommand(definition: CommandDefinition): CommandDescription | undefined {
  if (definition.since === undefined) return undefined;
  return {
    name: definition.name,
    args: jsonSchemaOf(definition.args),
    result: jsonSchemaOf(definition.result),
    since: definition.since,
    level: definition.level,
    confirm: definition.confirm,
    irreversible: definition.irreversible,
  };
}

export function describeRead(definition: ReadDefinition): ReadDescription | undefined {
  if (definition.since === undefined) return undefined;
  return {
    name: definition.name,
    args: jsonSchemaOf(definition.args),
    result: jsonSchemaOf(definition.result),
    since: definition.since,
  };
}
