// The one log line of each command and read a client sends (DIPO-320): its name, request id, office
// when it names one, outcome (`ok` or the error code) and milliseconds on the engine clock. The
// executors write it; a request the lifecycle checks refuse before an executor runs gets it from
// the surface. The outcome is the one the client got: when the daemon answered a read at its
// deadline, the line names that error, and the late reply writes none. The engine's own reads
// (the desk notification) write no line. Args and results stay out of it (0005).

import {
  type CommandReply,
  type EngineError,
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
 * Runs `answer` and writes its one line. A throw is logged as `internal` and passed on: the
 * surface turns it into that reply. When `answeredWithout` settles first, the client got that
 * error instead (the daemon's read deadline): the line names it, and the late reply writes none.
 */
export async function answerAndLog<R extends CommandReply | ReadReply>(
  logger: Logger | undefined,
  now: () => number,
  entry: Omit<RequestLogEntry, "reply" | "ms">,
  answer: () => Promise<R>,
  answeredWithout?: Promise<EngineError>,
): Promise<R> {
  const startedAt = now();
  let logged = false;
  const log = (reply: CommandReply | ReadReply) => {
    if (logged) return;
    logged = true;
    logRequest(logger, { ...entry, reply, ms: now() - startedAt });
  };
  const failed = (error: EngineError) => log({ ok: false, requestId: entry.requestId, error });
  void answeredWithout?.then(failed);
  try {
    const reply = await answer();
    log(reply);
    return reply;
  } catch (error) {
    failed({ code: "internal", message: "", retryable: false });
    throw error;
  }
}
