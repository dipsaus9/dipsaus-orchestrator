// The read executor (0005 section 7). Reads change no facts. Args are validated like command args;
// a read whose args name an `office` gets that office's handle and runs in one deferred
// transaction, so a snapshot and its cursor match; story references resolve as for commands. A
// waiting read (DIPO-71) resolves its references in that transaction and runs its handler after it.
// Each read writes one log line with its outcome and duration (DIPO-320).

import {
  argsInvalid,
  type Clock,
  engineError,
  type EngineError,
  type ReadReply,
  type ReadRequest,
  type RequestId,
} from "@dipsaus-orchestrator/contract";

import { errorFromThrown } from "../commands/errors";
import type { OfficeDirectory } from "../commands/offices";
import type { ReadContext, RegisteredRead, Registry } from "../commands/registry";
import { answerAndLog, officeInArgs } from "../commands/request-log";
import { findStoryRefFields, resolveStoryRefs } from "../commands/story-refs";
import type { OfficeHandle } from "../db/office";
import type { Logger } from "../log/logger";

export interface ReadDeps {
  readonly registry: Registry;
  readonly offices: OfficeDirectory;
  readonly clock: Clock;
  /** Where each read's line goes; none in tests that do not read it. */
  readonly logger?: Logger;
}

function failure(requestId: RequestId, error: EngineError): ReadReply {
  return { ok: false, requestId, error };
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

/** How a read is asked: by a client (the default) or by the engine itself. */
export interface ReadOptions {
  /** The engine's own read, such as the desk notification's: it writes no request line. */
  readonly internal?: boolean;
  /**
   * Settles when the caller answered the client without this read's reply (the daemon's read
   * deadline, DIPO-320): the request line names that error, and the late reply writes none.
   */
  readonly answeredWithout?: Promise<EngineError>;
}

/**
 * Runs one read and writes its log line. Unknown or unbuilt reads fail with `capability.missing`,
 * bad args with `args.invalid`, and args naming an unknown or forgotten office with
 * `office.unknown`.
 */
export function executeRead(
  deps: ReadDeps,
  request: ReadRequest,
  options: ReadOptions = {},
): Promise<ReadReply> {
  const entry = {
    kind: "read",
    name: request.name,
    requestId: request.requestId,
    office: officeInArgs(request.args),
  } as const;
  return answerAndLog(
    options.internal === true ? undefined : deps.logger,
    () => deps.clock.now(),
    entry,
    () => answerRead(deps, request),
    options.answeredWithout,
  );
}

async function answerRead(deps: ReadDeps, request: ReadRequest): Promise<ReadReply> {
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
  const officeId = officeInArgs(parsed.data);
  try {
    let office: OfficeHandle | undefined;
    if (officeId !== undefined) {
      // A read that has an answer for a loading office gives it now, not after the load (DIPO-380).
      if (read.whileLoading !== undefined && deps.offices.loading?.(officeId) === true) {
        return reply(read, request, read.whileLoading(officeId, deps.clock.now()));
      }
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
