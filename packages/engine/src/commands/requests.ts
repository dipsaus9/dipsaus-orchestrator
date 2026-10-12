// Idempotency records (0005 section 9, 0007 section 4). The engine keeps a request's id, a hash of
// its command name and resolved args (never the args themselves) and its reply for 24 hours.
// Office commands keep them in the office's `requests` table, in the command's transaction;
// software-level commands have no office database, so the daemon keeps theirs in memory for its
// lifetime with the same 24-hour cap.

import { createHash } from "node:crypto";

import type { Clock, CommandReply, RequestId } from "@dipsaus-orchestrator/contract";

import { canonicalJson } from "../config/merge";
import type { OfficeHandle } from "../db/office";

/** How long a request record answers a retry (0007 section 7, tier D). */
export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

/** sha256 over the command name and its args after story references resolved to keys. */
export function argsHash(command: string, resolvedArgs: unknown): string {
  return createHash("sha256")
    .update(`${command}\n${canonicalJson(resolvedArgs)}`)
    .digest("hex");
}

export interface RequestRecord {
  readonly command: string;
  readonly argsHash: string;
  readonly reply: CommandReply;
}

interface RequestRow {
  command: string;
  args_hash: string;
  reply: string;
}

/** The office's record for `requestId` if it is younger than 24 hours. */
export function findOfficeRequest(
  office: OfficeHandle,
  requestId: RequestId,
  now: number,
): RequestRecord | null {
  const row = office.get<RequestRow>(
    "select command, args_hash, reply from requests where office_id = $office_id and request_id = $request_id and at > $since",
    { request_id: requestId, since: now - REQUEST_TTL_MS },
  );
  if (row === null) return null;
  return {
    command: row.command,
    argsHash: row.args_hash,
    reply: JSON.parse(row.reply) as CommandReply,
  };
}

/** Stores the record; an expired record with the same id is replaced. */
export function saveOfficeRequest(
  office: OfficeHandle,
  requestId: RequestId,
  record: RequestRecord,
  now: number,
): void {
  office.run(
    `insert or replace into requests (office_id, request_id, command, args_hash, reply, at)
     values ($office_id, $request_id, $command, $args_hash, $reply, $at)`,
    {
      request_id: requestId,
      command: record.command,
      args_hash: record.argsHash,
      reply: JSON.stringify(record.reply),
      at: now,
    },
  );
}

/** The daemon's in-memory request table for software-level commands (0005 section 9). */
/** A software-level request whose handler has not finished; duplicates share its reply. */
export interface InFlightRequest {
  readonly command: string;
  readonly argsHash: string;
  readonly reply: Promise<CommandReply>;
}

export class MemoryRequestTable {
  readonly #clock: Clock;
  readonly #records = new Map<string, RequestRecord & { readonly at: number }>();
  readonly #running = new Map<string, InFlightRequest>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  find(requestId: RequestId): RequestRecord | null {
    this.#expire();
    return this.#records.get(requestId) ?? null;
  }

  save(requestId: RequestId, record: RequestRecord): void {
    this.#expire();
    this.#records.set(requestId, { ...record, at: this.#clock.now() });
  }

  /** The request with this id that is still running, if any. */
  inFlight(requestId: RequestId): InFlightRequest | undefined {
    return this.#running.get(requestId);
  }

  begin(requestId: RequestId, request: InFlightRequest): void {
    this.#running.set(requestId, request);
  }

  end(requestId: RequestId): void {
    this.#running.delete(requestId);
  }

  get size(): number {
    this.#expire();
    return this.#records.size;
  }

  #expire(): void {
    const cutoff = this.#clock.now() - REQUEST_TTL_MS;
    for (const [id, record] of this.#records) {
      if (record.at <= cutoff) this.#records.delete(id);
    }
  }
}
