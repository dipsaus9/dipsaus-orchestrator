// The read executor (0005 section 7). Reads change no facts. Args are validated like command args;
// a read whose args name an `office` gets that office's handle and runs in one deferred
// transaction, so a snapshot and its cursor match; story references resolve as for commands.

import {
  type Clock,
  engineError,
  type EngineError,
  OfficeId,
  type ReadReply,
  type ReadRequest,
  type RequestId,
} from "@dipsaus-orchestrator/contract";

import { argsInvalid } from "../commands/execute";
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

function run(
  deps: ReadDeps,
  read: RegisteredRead,
  request: ReadRequest,
  args: unknown,
  office: OfficeHandle | undefined,
): ReadReply {
  const { requestId } = request;
  let stories: ReadContext["stories"] = new Map();
  let resolvedArgs = args;
  if (office !== undefined) {
    const resolved = resolveStoryRefs(office, findStoryRefFields(read.definition.args), args);
    if (!resolved.ok) return failure(requestId, resolved.error);
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
  const parsed = read.definition.result.safeParse(read.handle(ctx, resolvedArgs));
  if (!parsed.success) {
    throw new Error(
      `${read.definition.name} returned a result that does not match its schema: ${parsed.error.message}`,
    );
  }
  return { ok: true, requestId, result: parsed.data };
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
    if (officeId === undefined) return run(deps, read, request, parsed.data, undefined);
    const office = deps.offices.get(officeId);
    if (office === undefined) {
      return failure(
        requestId,
        engineError("office.unknown", `There is no open office ${officeId}.`, {
          office: officeId,
        }),
      );
    }
    return office.deferred(() => run(deps, read, request, parsed.data, office));
  } catch (thrown) {
    return failure(requestId, errorFromThrown(thrown));
  }
}
