// How the contract defines its commands, reads and events, and how `commands.describe` renders
// them. Client and daemon ship in one binary and speak one contract (0005): a definition carries
// no version.

import { z } from "zod";

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
  // Since minor 1 (DIPO-160, 0020 section 14): argument names that make a call irreversible when
  // they are set to something other than false, such as `story.drop` with `deleteBranch`.
  irreversibleWhen?: readonly string[] | undefined;
  // Since minor 1 (DIPO-155, 0020 section 4): argument names that make a call need the yes/no
  // confirmation of `confirm` when they are set, such as `work.resume` with `budget`: every client
  // asks first, the CLI showing the caps before and after.
  confirmWhen?: readonly string[] | undefined;
};

export type ReadDefinition<
  N extends string = string,
  A extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> = { name: N; args: A; result: R };

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

export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

export const ReadDescription = z.object({
  name: z.string(),
  args: JsonSchema,
  result: JsonSchema,
});
export type ReadDescription = z.infer<typeof ReadDescription>;

export const CommandDescription = z.object({
  ...ReadDescription.shape,
  level: z.enum(["software", "office"]),
  confirm: z.boolean(),
  irreversible: z.boolean(),
  irreversibleWhen: z.array(z.string()).optional(),
  confirmWhen: z.array(z.string()).optional(),
});
export type CommandDescription = z.infer<typeof CommandDescription>;

// JSON Schema of one zod schema without the per-document `$schema` keyword. Always the input side:
// zod's output side adds `additionalProperties: false` to every object, which would make a reader
// of another language reject fields it does not know yet. A field with a default is optional on
// this side.
export function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
}

export function describeCommand(definition: CommandDefinition): CommandDescription {
  return {
    name: definition.name,
    args: jsonSchemaOf(definition.args),
    result: jsonSchemaOf(definition.result),
    level: definition.level,
    confirm: definition.confirm,
    irreversible: definition.irreversible,
    ...(definition.irreversibleWhen === undefined
      ? {}
      : { irreversibleWhen: [...definition.irreversibleWhen] }),
    ...(definition.confirmWhen === undefined ? {} : { confirmWhen: [...definition.confirmWhen] }),
  };
}

export function describeRead(definition: ReadDefinition): ReadDescription {
  return {
    name: definition.name,
    args: jsonSchemaOf(definition.args),
    result: jsonSchemaOf(definition.result),
  };
}
