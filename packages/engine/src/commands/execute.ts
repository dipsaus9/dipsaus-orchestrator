// The one command executor (0005 sections 1, 3 and 9). It validates the args, checks confirmation
// and the office, resolves story references to keys, and then, in one immediate transaction,
// answers a retry from its stored reply or runs the handler and writes its facts, its change-log
// entries and the `requests` record together. A handler that throws leaves no row and consumes no
// seq. Only then does it reply.

import {
  type Clock,
  type CommandReply,
  type CommandRequest,
  type Cursor,
  type EngineError,
  engineError,
  type IdSource,
  type RequestId,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";

import { errorFromThrown } from "./errors";
import type { OfficeDirectory } from "./offices";
import type { CommandContext, CommandOutcome, RegisteredCommand, Registry } from "./registry";
import {
  argsHash,
  findOfficeRequest,
  MemoryRequestTable,
  type RequestRecord,
  saveOfficeRequest,
} from "./requests";
import { findStoryRefFields, resolveStoryRefs } from "./story-refs";

export interface ExecutorDeps {
  readonly registry: Registry;
  readonly offices: OfficeDirectory;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** Idempotency records of software-level commands, kept for the daemon's lifetime. */
  readonly softwareRequests: MemoryRequestTable;
}

function failure(requestId: RequestId, error: EngineError): CommandReply {
  return { ok: false, requestId, error };
}

/** `args.invalid` with the zod issues in `details.issues`. */
export function argsInvalid(message: string, issues: readonly unknown[] = []): EngineError {
  return engineError("args.invalid", message, { issues });
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Retry handling (0005 section 9): the stored reply, `request.reused`, or null to run. */
function priorReply(
  requestId: RequestId,
  prior: RequestRecord | null,
  command: string,
  hash: string,
): CommandReply | null {
  if (prior === null) return null;
  if (prior.command === command && prior.argsHash === hash) return prior.reply;
  return reused(requestId);
}

function reused(requestId: RequestId): CommandReply {
  return failure(
    requestId,
    engineError(
      "request.reused",
      "This request id was already used for a different command or arguments; send a new request id.",
    ),
  );
}

function checkResult(command: RegisteredCommand, outcome: CommandOutcome<unknown>): unknown {
  const parsed = command.definition.result.safeParse(outcome.result);
  if (!parsed.success) {
    throw new Error(
      `${command.definition.name} returned a result that does not match its schema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function runOfficeCommand(
  deps: ExecutorDeps,
  command: Extract<RegisteredCommand, { level: "office" }>,
  office: OfficeHandle,
  request: CommandRequest,
  args: unknown,
): CommandReply {
  const { requestId } = request;
  const name = command.definition.name;
  const now = deps.clock.now();
  const refFields = findStoryRefFields(command.definition.args);
  try {
    return office.immediate((): CommandReply => {
      // The record first: a retry of a command that succeeded gets its reply even when a story it
      // named has since been removed or renumbered out of reach.
      const record = findOfficeRequest(office, requestId, now);
      if (record !== null && record.command !== name) return reused(requestId);
      const resolved = resolveStoryRefs(office, refFields, args);
      if (!resolved.ok) return record === null ? failure(requestId, resolved.error) : record.reply;
      const hash = argsHash(name, resolved.args);
      const prior = priorReply(requestId, record, name, hash);
      if (prior !== null) return prior;

      const entries: NewEntry[] = [];
      const ctx: CommandContext = {
        office,
        clock: deps.clock,
        ids: deps.ids,
        requestId,
        origin: request.origin,
        now,
        stories: resolved.stories,
        emit: (entry) => {
          entries.push(entry);
        },
      };
      const outcome = command.handle(ctx, resolved.args);
      if (isThenable(outcome)) {
        throw new Error(`${name} returned a promise; office command handlers are synchronous.`);
      }
      const result = checkResult(command, outcome);
      const cursor: Cursor | undefined = appendEntries(office, entries, {
        at: now,
        causedBy: requestId,
      });
      const reply: CommandReply = {
        ok: true,
        requestId,
        result,
        changed: outcome.changed ?? entries.length > 0,
        ...(cursor === undefined ? {} : { cursor }),
      };
      saveOfficeRequest(office, requestId, { command: name, argsHash: hash, reply }, now);
      return reply;
    });
  } catch (thrown) {
    return failure(requestId, errorFromThrown(thrown));
  }
}

async function runSoftwareCommand(
  deps: ExecutorDeps,
  command: Extract<RegisteredCommand, { level: "software" }>,
  request: CommandRequest,
  args: unknown,
): Promise<CommandReply> {
  const { requestId } = request;
  const name = command.definition.name;
  const hash = argsHash(name, args);
  const prior = priorReply(requestId, deps.softwareRequests.find(requestId), name, hash);
  if (prior !== null) return prior;
  // A duplicate that arrives while the first is still running waits for the same reply.
  const running = deps.softwareRequests.inFlight(requestId);
  if (running !== undefined) {
    return running.command === name && running.argsHash === hash
      ? running.reply
      : reused(requestId);
  }
  const reply = handleSoftwareCommand(deps, command, request, args, hash);
  deps.softwareRequests.begin(requestId, { command: name, argsHash: hash, reply });
  try {
    return await reply;
  } finally {
    deps.softwareRequests.end(requestId);
  }
}

async function handleSoftwareCommand(
  deps: ExecutorDeps,
  command: Extract<RegisteredCommand, { level: "software" }>,
  request: CommandRequest,
  args: unknown,
  hash: string,
): Promise<CommandReply> {
  const { requestId } = request;
  const name = command.definition.name;
  try {
    const outcome = await command.handle(
      {
        clock: deps.clock,
        ids: deps.ids,
        requestId,
        origin: request.origin,
        now: deps.clock.now(),
      },
      args,
    );
    const result = checkResult(command, outcome);
    const reply: CommandReply = { ok: true, requestId, result, changed: outcome.changed ?? false };
    deps.softwareRequests.save(requestId, { command: name, argsHash: hash, reply });
    return reply;
  } catch (thrown) {
    return failure(requestId, errorFromThrown(thrown));
  }
}

/**
 * Runs one command and returns its one reply. Unknown or unbuilt commands fail with
 * `capability.missing`; a conversation command without `confirmed` with `confirmation.required`;
 * bad args with `args.invalid` and the zod issues; an office-level command without `office` with
 * `args.invalid`, with an unknown or forgotten office with `office.unknown`, and with an office
 * whose engine instance would not load with that refusal (`office.refused`, `office.pathMissing`).
 */
export async function executeCommand(
  deps: ExecutorDeps,
  request: CommandRequest,
): Promise<CommandReply> {
  const { requestId } = request;
  const command = deps.registry.command(request.name);
  if (command === undefined) {
    return failure(
      requestId,
      engineError("capability.missing", `This engine has no command ${request.name}.`, {
        name: request.name,
      }),
    );
  }
  if (request.origin === "conversation" && request.confirmed !== true) {
    return failure(
      requestId,
      engineError(
        "confirmation.required",
        "A command proposed in conversation runs only after the maintainer confirms it.",
      ),
    );
  }
  const officeId = request.office;
  if (command.level === "office" && officeId === undefined) {
    return failure(
      requestId,
      argsInvalid(`${request.name} is an office-level command and needs an office.`),
    );
  }
  const parsed = command.definition.args.safeParse(request.args);
  if (!parsed.success) {
    return failure(
      requestId,
      argsInvalid(`The arguments of ${request.name} are not valid.`, parsed.error.issues),
    );
  }
  if (command.level === "software") {
    return runSoftwareCommand(deps, command, request, parsed.data);
  }
  if (officeId === undefined) return failure(requestId, argsInvalid("No office."));
  // The office's engine instance loads on its first command (0006 decision 4, DIPO-27).
  const access = await deps.offices.load(officeId);
  if (!access.ok) return failure(requestId, access.error);
  return runOfficeCommand(deps, command, access.office, request, parsed.data);
}
