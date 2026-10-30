// A hand-written engine surface for the socket server's tests (DIPO-318). The server takes only the
// `EngineSurface` type from the engine, so its protocol (the handshake, the frozen surface, frames,
// subscriptions, catch-up pages, heartbeats, derived summaries, backpressure, presence) is tested
// here against in-memory streams; what the engine answers is the engine's own tests' concern
// (`packages/engine/test/create/surface.test.ts`).

import {
  type CommandReply,
  type CommandRequest,
  type Cursor,
  engineError,
  type Event,
  type OfficeId,
  type OfficeSummary,
  type ReadReply,
  type ReadRequest,
  type RequestId,
  SOFTWARE_STREAM,
  StreamName,
} from "@dipsaus-orchestrator/contract";
import type { EngineSurface, OfficePage, Subscribed } from "@dipsaus-orchestrator/engine";

export const TEST_VERSION = "0.0.0-test";

/** One command or read as the fake heard it, with the connection's client name. */
export interface Heard {
  readonly kind: "command" | "read";
  readonly name: string;
  readonly office?: OfficeId;
  readonly client?: string;
}

/** A command the fake answers; it may append office entries through `fake`. */
export type FakeCommand = (request: CommandRequest, fake: FakeSurface) => CommandReply;

interface FakeOffice {
  readonly entries: Event[];
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

export class FakeSurface implements EngineSurface {
  readonly version = TEST_VERSION;
  readonly heard: Heard[] = [];
  readonly commands = new Map<string, FakeCommand>();
  /** The summaries `officeSummaries` and `officeSummary` give; tests change them. */
  summaries: OfficeSummary[] = [];
  /** Office pages read, counted by entry; backpressure tests read it. */
  paged = 0;
  /** Offices whose next page throws, as a broken renderer would. */
  readonly broken = new Set<OfficeId>();
  readonly #offices = new Map<OfficeId, FakeOffice>();
  readonly #software: Event[] = [];
  /** The software stream's seq before its first entry: the real one starts at the start time. */
  readonly #softwareStart = 1_000;
  readonly #softwareListeners = new Set<(event: Event) => void>();
  readonly #officeListeners = new Set<(office: OfficeId) => void>();
  #now = 0;

  constructor() {
    this.commands.set("fixture.scan", (request, fake) => fake.#scan(request));
    this.commands.set("daemon.stop", (request) => ({
      ok: true,
      requestId: request.requestId,
      result: { state: "draining" },
      changed: true,
    }));
  }

  // The fake's own streams.

  /** Adds an office with an empty change log. */
  addOffice(office: OfficeId): void {
    this.#offices.set(office, { entries: [] });
  }

  /** Forgets an office: a subscribe gets office.unknown, a page finds it gone. */
  forget(office: OfficeId): void {
    this.#offices.delete(office);
  }

  /** The head cursor of `office`'s change log. */
  officeHead(office: OfficeId): Cursor {
    const log = this.#office(office);
    return { stream: this.#stream(office), seq: log.entries.length } as Cursor;
  }

  /** Appends one entry to `office`'s change log; `notifyOffice` tells the subscribers. */
  appendOffice(office: OfficeId, type: string, data: unknown, causedBy?: RequestId): Event {
    const log = this.#office(office);
    const event: Event = {
      cursor: { stream: this.#stream(office), seq: log.entries.length + 1 },
      at: iso(this.#now),
      type,
      data,
      ...(causedBy === undefined ? {} : { causedBy }),
    } as Event;
    log.entries.push(event);
    return event;
  }

  /** New entries in `office`'s change log, as the engine tells after a transaction. */
  notifyOffice(office: OfficeId): void {
    for (const listener of this.#officeListeners) listener(office);
  }

  softwareHead(): Cursor {
    return { stream: SOFTWARE_STREAM, seq: this.#softwareStart + this.#software.length };
  }

  /** Appends a software event and sends it to every live subscriber. */
  appendSoftware(type: string, data: unknown): Event {
    const event = {
      cursor: { stream: SOFTWARE_STREAM, seq: this.softwareHead().seq + 1 },
      at: iso(this.#now),
      type,
      data,
    } as Event;
    this.#software.push(event);
    for (const listener of this.#softwareListeners) listener(event);
    return event;
  }

  // The surface.

  async executeCommand(
    request: CommandRequest,
    connection: { readonly client?: string } = {},
    send: (reply: CommandReply) => void = () => {},
  ): Promise<CommandReply> {
    this.heard.push({
      kind: "command",
      name: request.name,
      ...(request.office === undefined ? {} : { office: request.office }),
      ...(connection.client === undefined ? {} : { client: connection.client }),
    });
    const handle = this.commands.get(request.name);
    const reply: CommandReply =
      handle === undefined
        ? {
            ok: false,
            requestId: request.requestId,
            error: engineError("command.unknown", `no ${request.name} here`),
          }
        : handle(request, this);
    send(reply);
    if (reply.ok && reply.cursor !== undefined && request.office !== undefined) {
      this.notifyOffice(request.office);
    }
    return reply;
  }

  async executeRead(request: ReadRequest): Promise<ReadReply> {
    this.heard.push({ kind: "read", name: request.name });
    const { requestId } = request;
    switch (request.name) {
      case "engine.hello": {
        return {
          ok: true,
          requestId,
          result: {
            engine: this.version,
            daemon: "running",
            offices: this.summaries,
            cursor: this.softwareHead(),
          },
        };
      }
      case "daemon.status":
        return {
          ok: true,
          requestId,
          result: { state: "running", pid: process.pid, version: this.version },
        };
      case "commands.describe":
        return { ok: true, requestId, result: { commands: [], reads: [] } };
      default:
        return { ok: false, requestId, error: engineError("read.unknown", "unknown read") };
    }
  }

  async subscribe(stream: StreamName, after: Cursor | undefined): Promise<Subscribed> {
    if (stream === SOFTWARE_STREAM) {
      const from = after ?? this.softwareHead();
      // A cursor of an earlier daemon is older than this one's start.
      if (from.seq < this.#softwareStart || from.seq > this.softwareHead().seq) {
        return {
          ok: false,
          error: engineError("stream.resetRequired", "subscribe again", {
            oldest: { ...this.softwareHead(), seq: this.#softwareStart },
          }),
        };
      }
      return {
        ok: true,
        from,
        office: null,
        events: this.#software.slice(from.seq - this.#softwareStart),
        head: this.softwareHead(),
      };
    }
    const office = stream.slice("office:".length) as OfficeId;
    const log = this.#offices.get(office);
    if (log === undefined) {
      return { ok: false, error: engineError("office.unknown", `no office ${office}`) };
    }
    const from = after ?? this.officeHead(office);
    // Beyond the last entry: a log that was lost and started again.
    if (from.seq > log.entries.length) {
      return {
        ok: false,
        error: engineError("stream.resetRequired", "subscribe again", {
          oldest: { ...this.officeHead(office), seq: 0 },
        }),
      };
    }
    return { ok: true, from, office };
  }

  officePage(office: OfficeId, position: Cursor, limit: number): OfficePage {
    const log = this.#offices.get(office);
    if (log === undefined) return { kind: "gone" };
    if (this.broken.has(office)) throw new Error("the renderer broke");
    const events = log.entries.slice(position.seq, position.seq + limit);
    this.paged += events.length;
    return { kind: "page", events, last: events.length < limit };
  }

  onSoftwareEvent(listener: (event: Event) => void): () => void {
    this.#softwareListeners.add(listener);
    return () => this.#softwareListeners.delete(listener);
  }

  onOfficeChanged(listener: (office: OfficeId) => void): () => void {
    this.#officeListeners.add(listener);
    return () => this.#officeListeners.delete(listener);
  }

  officeSummaries(): readonly OfficeSummary[] {
    return this.summaries;
  }

  officeSummary(office: OfficeId): OfficeSummary | undefined {
    return this.summaries.find((summary) => summary.office === office);
  }

  #office(office: OfficeId): FakeOffice {
    const log = this.#offices.get(office);
    if (log === undefined) throw new Error(`the fake has no office ${office}`);
    return log;
  }

  #stream(office: OfficeId): StreamName {
    return StreamName.parse(`office:${office}`);
  }

  /** `fixture.scan`: one `scan.finished` entry in the request's office. */
  #scan(request: CommandRequest): CommandReply {
    const office = request.office;
    if (office === undefined) {
      return {
        ok: false,
        requestId: request.requestId,
        error: engineError("args.invalid", "no office"),
      };
    }
    const event = this.appendOffice(
      office,
      "scan.finished",
      { scripts: { test: "bun test" }, warnings: [] },
      request.requestId,
    );
    return {
      ok: true,
      requestId: request.requestId,
      result: { scan: "started" },
      changed: true,
      cursor: event.cursor,
    };
  }
}
