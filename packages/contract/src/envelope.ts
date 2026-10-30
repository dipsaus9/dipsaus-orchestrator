// Envelopes and frames of 0005 section 3. Any transport carries one frame per message.

import { z } from "zod";

import { EngineError } from "./errors";
import { Cursor, OfficeId, RequestId } from "./ids";

// Dotted names such as `work.steer`. Names stay open strings in the envelope: a frame with a name
// this side does not know still parses, and the engine answers it with an error, never a broken
// connection. The schema for `args`, `result` or `data` is chosen by the name.
const dottedName = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

export const CommandName = z
  .string()
  .regex(dottedName, "expected a dotted name such as work.steer");
export type CommandName = z.infer<typeof CommandName>;

export const ReadName = z.string().regex(dottedName, "expected a dotted name such as engine.hello");
export type ReadName = z.infer<typeof ReadName>;

export const EventType = z.string().regex(dottedName, "expected a dotted name such as work.phase");
export type EventType = z.infer<typeof EventType>;

export const Origin = z.enum(["cli", "tui", "conversation", "web", "other"]);
export type Origin = z.infer<typeof Origin>;

export const CommandRequest = z.object({
  requestId: RequestId,
  // Required on office-level commands; software-level ones omit it and name an office in args.
  office: OfficeId.optional(),
  name: CommandName,
  args: z.unknown(), // validated against the schema for `name`
  origin: Origin,
  confirmed: z.boolean().default(false), // 0005 section 9
});
export type CommandRequest = z.infer<typeof CommandRequest>;

export const ReadRequest = z.object({
  requestId: RequestId,
  name: ReadName,
  args: z.unknown(),
});
export type ReadRequest = z.infer<typeof ReadRequest>;

export const CommandReply = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    requestId: RequestId,
    result: z.unknown(),
    changed: z.boolean(), // false: valid, but the state already matched
    cursor: Cursor.optional(), // position of the last change-log entry written
  }),
  z.object({ ok: z.literal(false), requestId: RequestId, error: EngineError }),
]);
export type CommandReply = z.infer<typeof CommandReply>;

export const ReadReply = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), requestId: RequestId, result: z.unknown() }),
  z.object({ ok: z.literal(false), requestId: RequestId, error: EngineError }),
]);
export type ReadReply = z.infer<typeof ReadReply>;

export const Event = z.object({
  cursor: Cursor, // ordered within the stream; unique except for derived events
  at: z.iso.datetime(), // when the fact was stored
  type: EventType,
  causedBy: RequestId.optional(), // command that led to it, if any
  data: z.unknown(), // schema chosen by `type`
});
export type Event = z.infer<typeof Event>;

export const ClientFrame = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), ...CommandRequest.shape }),
  z.object({ kind: z.literal("read"), ...ReadRequest.shape }),
  z.object({
    kind: z.literal("subscribe"),
    requestId: RequestId,
    stream: Cursor.shape.stream,
    after: Cursor.optional(),
    filter: z.array(z.string()).optional(), // event type prefixes
  }),
  z.object({ kind: z.literal("unsubscribe"), stream: Cursor.shape.stream }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export const ServerFrame = z.discriminatedUnion("kind", [
  // Matched by requestId, in any order.
  z.object({ kind: z.literal("reply"), reply: z.union([CommandReply, ReadReply]) }),
  // Routed by cursor.stream.
  z.object({ kind: z.literal("events"), events: z.array(Event).min(1) }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

// Ok result of a `subscribe` reply. The error is `stream.resetRequired` with `{ oldest }`.
export const SubscribeResult = z.object({ stream: Cursor.shape.stream, from: Cursor });
export type SubscribeResult = z.infer<typeof SubscribeResult>;
