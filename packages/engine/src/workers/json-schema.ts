// The JSON Schema a session's `--json-schema` gets, made from a zod schema (0008 section 1, DIPO-413).
// Every session schema comes through here, so one function decides the dialect: zod's `$schema`
// key names the 2020-12 dialect, which the CLI does not accept, so it is left out.

import { z } from "zod";

import type { JsonSchema } from "./types";

/** The JSON Schema of `schema` as `io` reads it, without the `$schema` dialect key. */
export function toJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io });
  return rest;
}
