// The read executor (0005 section 7). Reads change no facts. Args are validated like command args;
// a read whose args name an `office` gets that office's handle and runs in one deferred
// transaction, so a snapshot and its cursor match; story references resolve as for commands. A
// waiting read (DIPO-71) resolves its references in that transaction and runs its handler after it.

import {
  argsInvalid,
  type Clock,
  engineError,
  type EngineError,
  OfficeId,
  type ReadReply,
  type ReadRequest,
  type RequestId,
} from "@dipsaus-orchestrator/contract";

import { errorFromThrown } from "../commands/errors";
import type { OfficeDirectory } from "../commands/offices";
import type { ReadContext, RegisteredRead, Registry } from "../commands/registry";
import { findStoryRefFields, resolveStoryRefs } from "../commands/story-refs";
import type { OfficeHandle } from "../db/office";

export interface ReadDeps {
  readonly registry: Registry;
  readonly offices: OfficeDirectory;
  readonly clock: Clock;
}

function failure(requestId: RequestId, error: EngineError): ReadReply {
  return { ok: false, requestId, error };
}

function officeOf(args: unknown): OfficeId | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const parsed = OfficeId.safeParse((args as { office?: unknown }).office);
  return parsed.success ? parsed.data : undefined;
}

type Prepared =
  | { readonly ok: true; readonly ctx: ReadContext; readonly args: unknown }
  | { readonly ok: false; readonly reply: ReadReply };

/** Resolves the story references and builds the handler's context. */
function prepare(
  deps: ReadDeps,
  read: RegisteredRead,
  request: ReadRequest,
  args: unknown,
  office: OfficeHandle | undefined,
): Prepared {
  const { requestId } = request;
  let stories: ReadContext["stories"] = new Map();
  let resolvedArgs = args;
  if (office !== undefined) {
    const resolved = resolveStoryRefs(office, findStoryRefFields(read.definition.args), args);
    if (!resolved.ok) return { ok: false, reply: failure(requestId, resolved.error) };
    stories = resolved.stories;
    resolvedArgs = resolved.args;
  }
  const ctx: ReadContext = {
    clock: deps.clock,
    requestId,
    stories,
    registry: deps.registry,
    ...(office === undefined ? {} : { office }),
  };
  return { ok: true, ctx, args: resolvedArgs };
}

function reply(read: RegisteredRead, request: ReadRequest, result: unknown): ReadReply {
  const parsed = read.definition.result.safeParse(result);
  if (!parsed.success) {
    throw new Error(
      `${read.definition.name} returned a result that does not match its schema: ${parsed.error.message}`,
    );
  }
  return { ok: true, requestId: request.requestId, result: parsed.data };
}

/** Runs a synchronous read; for an office read the caller wraps it in a deferred transaction. */
function run(
  deps: ReadDeps,
  read: RegisteredRead & { readonly waits: false },
  request: ReadRequest,
  args: unknown,
  office: OfficeHandle | undefined,
): ReadReply {
  const prepared = prepare(deps, read, request, args, office);
  if (!prepared.ok) return prepared.reply;
  return reply(read, request, read.handle(prepared.ctx, prepared.args));
}

/** Runs a waiting read: references resolve in one deferred transaction, the handler after it. */
async function runWaiting(
  deps: ReadDeps,
  read: RegisteredRead & { readonly waits: true },
  request: ReadRequest,
  args: unknown,
  office: OfficeHandle | undefined,
): Promise<ReadReply> {
  const prepared =
    office === undefined
      ? prepare(deps, read, request, args, undefined)
      : office.deferred(() => prepare(deps, read, request, args, office));
  if (!prepared.ok) return prepared.reply;
  return reply(read, request, await read.handle(prepared.ctx, prepared.args));
}

/**
 * Runs one read. Unknown or unbuilt reads fail with `capability.missing`, bad args with
 * `args.invalid`, and args naming an unknown or forgotten office with `office.unknown`.
 */
export async function executeRead(deps: ReadDeps, request: ReadRequest): Promise<ReadReply> {
  const { requestId } = request;
  const read = deps.registry.read(request.name);
  if (read === undefined) {
    return failure(
      requestId,
      engineError("capability.missing", `This engine has no read ${request.name}.`, {
        name: request.name,
      }),
    );
  }
  const parsed = read.definition.args.safeParse(request.args);
  if (!parsed.success) {
    return failure(
      requestId,
      argsInvalid(`The arguments of ${request.name} are not valid.`, parsed.error.issues),
    );
  }
  const officeId = officeOf(parsed.data);
  try {
    let office: OfficeHandle | undefined;
    if (officeId !== undefined) {
      // A read loads the office's engine instance on first use, like a command (DIPO-27).
      const access = await deps.offices.load(officeId);
      if (!access.ok) return failure(requestId, access.error);
      office = access.office;
    }
    if (read.waits) return await runWaiting(deps, read, request, parsed.data, office);
    if (office === undefined) return run(deps, read, request, parsed.data, undefined);
    const handle = office;
    return handle.deferred(() => run(deps, read, request, parsed.data, handle));
  } catch (thrown) {
    return failure(requestId, errorFromThrown(thrown));
  }
}
