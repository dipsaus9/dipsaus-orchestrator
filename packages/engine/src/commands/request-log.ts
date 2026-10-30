// The one log line of each command and read (DIPO-320): its name, request id, office when it names
// one, outcome (`ok` or the error code) and milliseconds on the engine clock. The executors write
// it; a request the lifecycle checks refuse before an executor runs gets it from the surface. Args
// and results stay out of it (0005).

import {
  type CommandReply,
  OfficeId,
  type ReadReply,
  type RequestId,
} from "@dipsaus-orchestrator/contract";

import type { Logger } from "../log/logger";

export interface RequestLogEntry {
  readonly kind: "command" | "read";
  readonly name: string;
  readonly requestId: RequestId;
  /** The office it acts on or reads, when it names one. */
  readonly office?: OfficeId | undefined;
  readonly reply: CommandReply | ReadReply;
  readonly ms: number;
}

/** The office `args.office` names, for a software command or a read. */
export function officeInArgs(args: unknown): OfficeId | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const parsed = OfficeId.safeParse((args as { office?: unknown }).office);
  return parsed.success ? parsed.data : undefined;
}

/** Writes the request's one line at `info`. */
export function logRequest(logger: Logger | undefined, entry: RequestLogEntry): void {
  logger?.info(`${entry.kind} answered`, {
    name: entry.name,
    requestId: entry.requestId,
    ...(entry.office === undefined ? {} : { office: entry.office }),
    outcome: entry.reply.ok ? "ok" : entry.reply.error.code,
    ms: entry.ms,
  });
}

/**
 * Runs `answer` and writes its line. A throw is logged as `internal` and passed on: the surface
 * turns it into that reply.
 */
export async function answerAndLog<R extends CommandReply | ReadReply>(
  logger: Logger | undefined,
  now: () => number,
  entry: Omit<RequestLogEntry, "reply" | "ms">,
  answer: () => Promise<R>,
): Promise<R> {
  const startedAt = now();
  try {
    const reply = await answer();
    logRequest(logger, { ...entry, reply, ms: now() - startedAt });
    return reply;
  } catch (error) {
    logRequest(logger, {
      ...entry,
      reply: {
        ok: false,
        requestId: entry.requestId,
        error: { code: "internal", message: "", retryable: false },
      },
      ms: now() - startedAt,
    });
    throw error;
  }
}
