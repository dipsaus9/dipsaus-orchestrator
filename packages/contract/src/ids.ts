// Ids of 0005 section 2. Every id is a branded string. Engine-made ids are a prefix plus a ULID,
// story ids are Backlog.md ids unchanged, and request ids are bare ULIDs made by the client.

import { z } from "zod";

// Crockford base32, 26 characters. The first character is at most 7, so the value fits 128 bits.
const ULID = "[0-7][0-9A-HJKMNP-TV-Z]{25}";

function prefixed(prefix: string): RegExp {
  return new RegExp(`^${prefix}_${ULID}$`);
}

export const OfficeId = z
  .string()
  .regex(prefixed("off"), "expected off_<ulid>")
  .brand<"OfficeId">();
export type OfficeId = z.infer<typeof OfficeId>;

// A Backlog.md id such as `DIPO-2`, a sub-task such as `DIPO-2.1`, or a provisional `DRAFT-3`.
export const StoryId = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*-[0-9]+(\.[0-9]+)*$/, "expected a Backlog.md id such as DIPO-2")
  .brand<"StoryId">();
export type StoryId = z.infer<typeof StoryId>;

export const StoryKey = z
  .string()
  .regex(prefixed("sto"), "expected sto_<ulid>")
  .brand<"StoryKey">();
export type StoryKey = z.infer<typeof StoryKey>;

export const RunId = z.string().regex(prefixed("run"), "expected run_<ulid>").brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

export const AgentId = z.string().regex(prefixed("agt"), "expected agt_<ulid>").brand<"AgentId">();
export type AgentId = z.infer<typeof AgentId>;

// A role name from the office roster, such as `developer`.
export const RoleId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "expected a role name such as developer")
  .brand<"RoleId">();
export type RoleId = z.infer<typeof RoleId>;

export const GateId = z.string().regex(prefixed("gat"), "expected gat_<ulid>").brand<"GateId">();
export type GateId = z.infer<typeof GateId>;

export const QuestionId = z
  .string()
  .regex(prefixed("qst"), "expected qst_<ulid>")
  .brand<"QuestionId">();
export type QuestionId = z.infer<typeof QuestionId>;

export const TestId = z.string().regex(prefixed("tst"), "expected tst_<ulid>").brand<"TestId">();
export type TestId = z.infer<typeof TestId>;

// Client-made, one per command or read; the idempotency key for commands (0005 section 9).
export const RequestId = z
  .string()
  .regex(new RegExp(`^${ULID}$`), "expected a ULID")
  .brand<"RequestId">();
export type RequestId = z.infer<typeof RequestId>;

// `software`, or `office:<OfficeId>` for one office's change log.
export const StreamName = z
  .string()
  .regex(new RegExp(`^(software|office:off_${ULID})$`), "expected software or office:<OfficeId>")
  .brand<"StreamName">();
export type StreamName = z.infer<typeof StreamName>;

/** The software stream: daemon states, notices and office summaries (0005 section 8). */
export const SOFTWARE_STREAM: StreamName = StreamName.parse("software");

// A position in one stream (0005). A cursor older than the oldest stored entry, or beyond the
// last one, gets `stream.resetRequired`.
export const Cursor = z.object({
  stream: StreamName,
  seq: z.int().nonnegative(),
});
export type Cursor = z.infer<typeof Cursor>;
