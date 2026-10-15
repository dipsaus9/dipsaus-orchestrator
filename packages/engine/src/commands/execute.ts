// The one command executor (0005 sections 1, 3 and 9). It validates the args, checks confirmation
// and the office, resolves story references to keys, and then, in one immediate transaction,
// answers a retry from its stored reply or runs the handler and writes its facts, its change-log
// entries and the `requests` record together. A handler that throws leaves no row and consumes no
// seq. Only then does it reply. A waiting office command (DIPO-48) resolves and checks its retry in
// one transaction, runs its handler outside it, and writes its `requests` record after.
//
// Shared office resolution (DIPO-48): a command whose args carry `from`, the main worktree the
// client resolved the office from, fails with `office.unknown` when that is not the office's
// registered path, so a copied repository never acts on the original office.
//
// A story reference the office does not know first runs the registered story refreshes once
// (DIPO-104), so a story merged to the base since the last poll resolves.

import {
  type Clock,
  type CommandReply,
  type CommandRequest,
  type Cursor,
  type EngineError,
  engineError,
  type IdSource,
  OfficeId,
  type RequestId,
} from "@dipsaus-orchestrator/contract";

import { appendEntries, headCursor, type NewEntry } from "../changelog/log";
import type { OfficeHandle } from "../db/office";
import { canonicalPath } from "../office/repository";

import { errorFromThrown } from "./errors";
import type { OfficeDirectory } from "./offices";
import type {
  AsyncCommandContext,
  CommandContext,
  CommandOutcome,
  RegisteredCommand,
  Registry,
} from "./registry";
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
  command: Extract<RegisteredCommand, { level: "office"; waits: false }>,
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

/**
 * A waiting office command: the retry check and the story references in one transaction, the
 * handler outside any transaction (it commits its own facts), then the `requests` record. A
 * duplicate that arrives while the first still runs waits for the same reply.
 *
 * Invariant: a handler that throws leaves no `requests` record, but the facts it committed before
 * the throw stay. A retry with the same request id then runs the handler again, so every fact a
 * waiting handler commits must be idempotent under a re-run: the re-run must see it and not repeat
 * its effect (for `work.run`, a claimed story has a live claim and an active run, so the re-run
 * skips it instead of claiming it twice).
 */
async function runAsyncOfficeCommand(
  deps: ExecutorDeps,
  command: Extract<RegisteredCommand, { level: "office"; waits: true }>,
  office: OfficeHandle,
  request: CommandRequest,
  args: unknown,
): Promise<CommandReply> {
  const { requestId } = request;
  const name = command.definition.name;
  const now = deps.clock.now();
  const refFields = findStoryRefFields(command.definition.args);
  let prepared:
    | { readonly reply: CommandReply }
    | { readonly hash: string; readonly ctx: Omit<AsyncCommandContext, "commit">; args: unknown };
  try {
    prepared = office.immediate(() => {
      const record = findOfficeRequest(office, requestId, now);
      if (record !== null && record.command !== name) return { reply: reused(requestId) };
      const resolved = resolveStoryRefs(office, refFields, args);
      if (!resolved.ok) {
        return { reply: record === null ? failure(requestId, resolved.error) : record.reply };
      }
      const hash = argsHash(name, resolved.args);
      const prior = priorReply(requestId, record, name, hash);
      if (prior !== null) return { reply: prior };
      return {
        hash,
        args: resolved.args,
        ctx: {
          office,
          clock: deps.clock,
          ids: deps.ids,
          requestId,
          origin: request.origin,
          now,
          stories: resolved.stories,
        },
      };
    });
  } catch (thrown) {
    return failure(requestId, errorFromThrown(thrown));
  }
  if ("reply" in prepared) return prepared.reply;
  const { hash } = prepared;
  const running = deps.softwareRequests.inFlight(requestId);
  if (running !== undefined) {
    return running.command === name && running.argsHash === hash
      ? running.reply
      : reused(requestId);
  }
  let committed = false;
  const ctx: AsyncCommandContext = {
    ...prepared.ctx,
    commit: (fn) => {
      office.immediate(() => {
        const entries = fn() ?? [];
        if (entries.length === 0) return;
        appendEntries(office, entries, { at: deps.clock.now(), causedBy: requestId });
        committed = true;
      });
    },
  };
  const handled = (async (): Promise<CommandReply> => {
    try {
      const outcome = await command.handle(ctx, prepared.args);
      const result = checkResult(command, outcome);
      return office.immediate((): CommandReply => {
        const reply: CommandReply = {
          ok: true,
          requestId,
          result,
          changed: outcome.changed ?? committed,
          ...(committed ? { cursor: headCursor(office) } : {}),
        };
        saveOfficeRequest(office, requestId, { command: name, argsHash: hash, reply }, now);
        return reply;
      });
    } catch (thrown) {
      return failure(requestId, errorFromThrown(thrown));
    }
  })();
  deps.softwareRequests.begin(requestId, { command: name, argsHash: hash, reply: handled });
  try {
    return await handled;
  } finally {
    deps.softwareRequests.end(requestId);
  }
}

/**
 * `office.unknown` when the args carry `from` and it is not the registered path of the office the
 * command acts on (canonical on both sides), or the office was never registered;
 * `engine.recovering` while the state database is not open. Null otherwise.
 */
function checkFrom(
  deps: ExecutorDeps,
  officeId: OfficeId | undefined,
  args: unknown,
): EngineError | null {
  if (typeof args !== "object" || args === null) return null;
  const from = (args as { from?: unknown }).from;
  if (typeof from !== "string" || officeId === undefined) return null;
  const lookup = deps.offices.registeredPath;
  if (lookup === undefined) return null;
  const registered = lookup.call(deps.offices, officeId);
  if (!registered.ok) return registered.error;
  const { path } = registered;
  if (canonicalPath(from) === canonicalPath(path)) return null;
  return engineError(
    "office.unknown",
    `${from} is not office ${officeId}, which is registered at ${path}.`,
    {
      office: officeId,
      from,
      reason: "path",
    },
  );
}

/** The office a command acts on: the envelope's for an office-level one, else `args.office`. */
function targetOffice(command: RegisteredCommand, request: CommandRequest, args: unknown) {
  if (command.level === "office") return request.office;
  if (typeof args !== "object" || args === null) return undefined;
  const parsed = OfficeId.safeParse((args as { office?: unknown }).office);
  return parsed.success ? parsed.data : undefined;
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
 * A story merged to the base since the last poll stays unknown to the office until an index pass
 * reads it (DIPO-104). When the args name a story the office does not know, the registered story
 * refreshes (a fetch, and an index pass when `_base` moved) run once first; the command then
 * resolves as usual and fails with `story.unknown` only when the story is still missing.
 */
async function refreshUnknownStories(
  deps: ExecutorDeps,
  command: Extract<RegisteredCommand, { level: "office" }>,
  officeId: OfficeId,
  office: OfficeHandle,
  args: unknown,
): Promise<void> {
  const refreshes = deps.registry.storyRefreshes();
  if (refreshes.length === 0) return;
  const fields = findStoryRefFields(command.definition.args);
  if (fields.length === 0) return;
  const resolved = resolveStoryRefs(office, fields, args);
  if (resolved.ok || resolved.error.code !== "story.unknown") return;
  for (const { refresh } of refreshes) await refresh(officeId).catch(() => undefined);
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
  const wrongPath = checkFrom(deps, targetOffice(command, request, parsed.data), parsed.data);
  if (wrongPath !== null) return failure(requestId, wrongPath);
  if (command.level === "software") {
    return runSoftwareCommand(deps, command, request, parsed.data);
  }
  if (officeId === undefined) return failure(requestId, argsInvalid("No office."));
  // The office's engine instance loads on its first command (0006 decision 4, DIPO-27).
  const access = await deps.offices.load(officeId);
  if (!access.ok) return failure(requestId, access.error);
  await refreshUnknownStories(deps, command, officeId, access.office, parsed.data);
  if (command.waits) {
    return runAsyncOfficeCommand(deps, command, access.office, request, parsed.data);
  }
  return runOfficeCommand(deps, command, access.office, request, parsed.data);
}
