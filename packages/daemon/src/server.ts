// The contract on `dipo.sock` (0005 sections 3, 7, 8 and 11; 0006 decision 9). Each WebSocket text
// frame holds one `ClientFrame` or `ServerFrame`. A connection starts with the `engine.hello` read;
// a client of another contract major may then use only the frozen surface (`engine.hello`,
// `daemon.status`, `daemon.stop`). Commands and reads go through the DIPO-22 executors after the
// lifecycle checks of 0006 decision 7. `subscribe` replays the software ring buffer or an office
// change log after the client's cursor, marks the end of catch-up, then sends live events, with a
// `stream.mark` heartbeat on an idle subscription. The engine keeps no per-connection state beyond
// the subscriptions and the handshake.

import {
  type Clock,
  type ClientFrame,
  type CommandReply,
  type Cursor,
  ClientFrame as ClientFrameSchema,
  type EngineError,
  engineError,
  type Event,
  type IdSource,
  OfficeId,
  type ReadReply,
  RequestId,
  type ServerFrame,
  type StreamName,
} from "@dipsaus-orchestrator/contract";
import {
  argsInvalid,
  CLOSE_INVALID_PAYLOAD,
  CLOSE_POLICY_VIOLATION,
  contractUnsupported,
  executeCommand,
  executeRead,
  headCursor,
  type Logger,
  type MemoryRequestTable,
  type OfficeDirectory,
  type OfficeHandle,
  type OfficeSummarySource,
  Renderer,
  replay,
  type Registry,
  SOFTWARE_STREAM,
  type ConnectionSession,
  type SocketConnection,
  type SoftwareStream,
} from "@dipsaus-orchestrator/engine";

import type { DaemonLifecycle } from "./lifecycle";

/** An idle subscription gets a `stream.mark` this often (0005 section 8). */
export const HEARTBEAT_MS = 15_000;
/** At most this many events go in one `events` frame. */
export const EVENTS_PER_FRAME = 500;
/** Office replay reads the change log in pages of this many entries. */
const REPLAY_PAGE = 1000;

/** Commands that would schedule work and so fail with `scheduling.off` in `safe` (0006 decision 7). */
export const SCHEDULING_COMMANDS: ReadonlySet<string> = new Set(["work.run"]);

/** Names any connection may use in every daemon state (0006 decision 7: `starting`). */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(["engine.hello", "commands.describe"]);

/** The frozen surface a client of another contract major may use (0005 section 11). */
const FROZEN_READS: ReadonlySet<string> = new Set(["engine.hello", "daemon.status"]);
const FROZEN_COMMANDS: ReadonlySet<string> = new Set(["daemon.stop"]);

export interface ContractServerDeps {
  readonly registry: Registry;
  readonly offices: OfficeDirectory;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly softwareRequests: MemoryRequestTable;
  readonly lifecycle: DaemonLifecycle;
  readonly software: SoftwareStream;
  readonly officeSummaries: OfficeSummarySource;
  readonly engineVersion: string;
  readonly logger: Logger;
  readonly renderer?: Renderer;
  readonly heartbeatMs?: number;
}

/**
 * The lifecycle check for one request (0006 decision 7), null when it may run: office commands and
 * reads get `engine.recovering` in `starting` and `recovering`; commands that schedule work get
 * `scheduling.off` in `safe`; in `draining` no command but `daemon.*` starts, also with the
 * retryable `scheduling.off`, so a client retries it against the next daemon. `engine.hello`,
 * `commands.describe` and `daemon.*` always run.
 */
export function lifecycleGate(
  lifecycle: DaemonLifecycle,
  kind: "command" | "read",
  name: string,
): EngineError | null {
  if (ALWAYS_ALLOWED.has(name) || name.startsWith("daemon.")) return null;
  const access = lifecycle.officeAccess();
  if (access !== null) return access;
  if (kind === "command" && (lifecycle.state === "draining" || SCHEDULING_COMMANDS.has(name))) {
    return lifecycle.scheduling();
  }
  return null;
}

interface Subscription {
  readonly stream: StreamName;
  readonly office: OfficeId | null;
  readonly filter: readonly string[];
  /** The last position the client has been brought to; marks repeat it. */
  position: Cursor;
  heartbeat: ReturnType<Clock["setTimeout"]> | null;
}

type HandshakeState = "new" | "ready" | "foreign";

function requestIdOf(raw: unknown): RequestId | null {
  if (typeof raw !== "object" || raw === null) return null;
  const parsed = RequestId.safeParse((raw as { requestId?: unknown }).requestId);
  return parsed.success ? parsed.data : null;
}

export class ContractServer {
  readonly #deps: ContractServerDeps;
  readonly #renderer: Renderer;
  readonly #heartbeatMs: number;
  readonly #connections = new Set<Connection>();

  constructor(deps: ContractServerDeps) {
    this.#deps = deps;
    this.#renderer = deps.renderer ?? new Renderer();
    this.#heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
    deps.software.onAppend((event) => {
      for (const connection of this.#connections) connection.softwareEvent(event);
    });
  }

  get deps(): ContractServerDeps {
    return this.#deps;
  }

  get renderer(): Renderer {
    return this.#renderer;
  }

  get heartbeatMs(): number {
    return this.#heartbeatMs;
  }

  /** Open connections. */
  get connections(): number {
    return this.#connections.size;
  }

  /** The session for one accepted connection; `serveUnixSocket` calls it. */
  accept(socket: SocketConnection): ConnectionSession {
    const connection = new Connection(this, socket, () => this.#connections.delete(connection));
    this.#connections.add(connection);
    return connection;
  }

  /**
   * New entries in `office`'s change log: every subscriber of that office catches up from its
   * position. Called after each command that wrote entries; later writers outside commands
   * (ingestion, reconcile) call it after their transaction too.
   */
  notifyOffice(office: OfficeId): void {
    for (const connection of this.#connections) connection.officeChanged(office);
  }
}

class Connection implements ConnectionSession {
  readonly #server: ContractServer;
  readonly #socket: SocketConnection;
  readonly #onClosed: () => void;
  #state: HandshakeState = "new";
  #closed = false;
  readonly #subscriptions = new Map<StreamName, Subscription>();
  /** Frames are taken in order; only the handshake and reads are awaited, commands run alongside. */
  #queue: Promise<void> = Promise.resolve();

  constructor(server: ContractServer, socket: SocketConnection, onClosed: () => void) {
    this.#server = server;
    this.#socket = socket;
    this.#onClosed = onClosed;
  }

  get #deps(): ContractServerDeps {
    return this.#server.deps;
  }

  message(text: string): void {
    this.#queue = this.#queue.then(
      () => this.#handle(text),
      () => this.#handle(text),
    );
  }

  closed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscription of this.#subscriptions.values()) this.#stopHeartbeat(subscription);
    this.#subscriptions.clear();
    this.#onClosed();
  }

  softwareEvent(event: Event): void {
    const subscription = this.#subscriptions.get(SOFTWARE_STREAM);
    if (subscription === undefined) return;
    this.#deliver(subscription, [event], event.cursor);
  }

  officeChanged(office: OfficeId): void {
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.office !== office) continue;
      const handle = this.#deps.offices.get(office);
      if (handle === undefined) {
        this.#dropSubscription(subscription);
        continue;
      }
      try {
        this.#catchUpOffice(subscription, handle);
      } catch (error) {
        this.#deps.logger.error("office stream delivery failed", { office, error });
        this.#close(CLOSE_POLICY_VIOLATION, "the office stream needs a reset; subscribe again");
      }
    }
  }

  // Frames

  async #handle(text: string): Promise<void> {
    if (this.#closed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.#close(CLOSE_INVALID_PAYLOAD, "a frame must be one JSON value");
      return;
    }
    const parsed = ClientFrameSchema.safeParse(raw);
    if (!parsed.success) {
      const requestId = requestIdOf(raw);
      if (requestId === null) {
        this.#close(CLOSE_INVALID_PAYLOAD, "the frame is not a dipo ClientFrame");
        return;
      }
      this.#reply({
        ok: false,
        requestId,
        error: argsInvalid("This frame is not a valid ClientFrame.", parsed.error.issues),
      });
      return;
    }
    const frame = parsed.data;
    if (this.#state === "new") {
      await this.#handshake(frame);
      return;
    }
    if (this.#state === "foreign") {
      await this.#foreign(frame);
      return;
    }
    await this.#ready(frame);
  }

  /** The first frame must be the `engine.hello` read (0006 decision 9). */
  async #handshake(frame: ClientFrame): Promise<void> {
    if (frame.kind === "read" && frame.name === "engine.hello") {
      const reply = await this.#read(frame);
      if (reply.ok) this.#state = "ready";
      else if (reply.error.code === "contract.unsupported") this.#state = "foreign";
      this.#reply(reply);
      return;
    }
    if (frame.kind === "unsubscribe") {
      this.#close(CLOSE_POLICY_VIOLATION, "the first frame must be the engine.hello read");
      return;
    }
    this.#reply({
      ok: false,
      requestId: frame.requestId,
      error: engineError(
        "not.permitted",
        "The first frame on a connection must be the engine.hello read.",
        { expected: "engine.hello" },
      ),
    });
  }

  /** A client of another major: only the frozen surface (0005 section 11). */
  async #foreign(frame: ClientFrame): Promise<void> {
    if (frame.kind === "read" && FROZEN_READS.has(frame.name)) {
      this.#reply(await this.#read(frame));
      return;
    }
    if (frame.kind === "command" && FROZEN_COMMANDS.has(frame.name)) {
      this.#command(frame);
      return;
    }
    if (frame.kind === "unsubscribe") return;
    this.#reply({
      ok: false,
      requestId: frame.requestId,
      error: contractUnsupported(this.#deps.engineVersion).error,
    });
  }

  async #ready(frame: ClientFrame): Promise<void> {
    switch (frame.kind) {
      case "read":
        this.#reply(await this.#read(frame));
        return;
      case "command":
        this.#command(frame);
        return;
      case "subscribe":
        this.#subscribe(frame);
        return;
      case "unsubscribe": {
        const subscription = this.#subscriptions.get(frame.stream);
        if (subscription !== undefined) this.#dropSubscription(subscription);
        return;
      }
      case "auth":
        // The Unix socket needs no auth (0006 decision 11): the runtime directory guards it.
        this.#reply({ ok: true, requestId: frame.requestId, result: {} });
        return;
    }
  }

  async #read(frame: Extract<ClientFrame, { kind: "read" }>): Promise<ReadReply> {
    const { requestId, name, args } = frame;
    const gate = lifecycleGate(this.#deps.lifecycle, "read", name);
    if (gate !== null) return { ok: false, requestId, error: gate };
    const deps = this.#deps;
    return executeRead(
      { registry: deps.registry, offices: deps.offices, clock: deps.clock },
      { requestId, name, args },
    );
  }

  /** Runs one command alongside later frames; its reply may come after theirs (0005 section 3). */
  #command(frame: Extract<ClientFrame, { kind: "command" }>): void {
    const { kind: _kind, ...request } = frame;
    const deps = this.#deps;
    const gate = lifecycleGate(deps.lifecycle, "command", request.name);
    if (gate !== null) {
      this.#reply({ ok: false, requestId: request.requestId, error: gate });
      return;
    }
    const end = deps.lifecycle.beginWork();
    executeCommand(
      {
        registry: deps.registry,
        offices: deps.offices,
        clock: deps.clock,
        ids: deps.ids,
        softwareRequests: deps.softwareRequests,
      },
      request,
    )
      .then(
        (reply: CommandReply) => {
          this.#reply(reply);
          if (reply.ok && reply.cursor !== undefined && request.office !== undefined) {
            this.#server.notifyOffice(request.office);
          }
        },
        (error: unknown) => {
          deps.logger.error("command failed", { command: request.name, error });
          this.#reply({
            ok: false,
            requestId: request.requestId,
            error: engineError("internal", "The engine failed while handling this command."),
          });
        },
      )
      .finally(() => end?.());
  }

  // Streams

  #subscribe(frame: Extract<ClientFrame, { kind: "subscribe" }>): void {
    const { requestId, stream } = frame;
    const filter = frame.filter ?? [];
    const previous = this.#subscriptions.get(stream);
    if (previous !== undefined) this.#dropSubscription(previous);

    if (stream === SOFTWARE_STREAM) {
      const software = this.#deps.software;
      const after = frame.after ?? software.head();
      const replayed = software.since(after);
      if (!replayed.ok) {
        this.#reply({ ok: false, requestId, error: replayed.error });
        return;
      }
      this.#reply({ ok: true, requestId, result: { stream, from: after } });
      const subscription = this.#addSubscription(stream, null, filter, after);
      this.#deliver(subscription, replayed.events, replayed.head);
      this.#mark(subscription, true);
      // Derived: the current summary of every office after catch-up (0005 section 5).
      const summaries = this.#deps.officeSummaries().map((summary) => ({
        cursor: subscription.position,
        at: this.#now(),
        type: "office.summary",
        data: summary,
      }));
      this.#sendEvents(subscription, summaries);
      return;
    }

    const gate = this.#deps.lifecycle.officeAccess();
    if (gate !== null) {
      this.#reply({ ok: false, requestId, error: gate });
      return;
    }
    const office = OfficeId.parse(stream.slice("office:".length));
    const handle = this.#deps.offices.get(office);
    if (handle === undefined) {
      this.#reply({
        ok: false,
        requestId,
        error: engineError("office.unknown", `There is no open office ${office}.`, { office }),
      });
      return;
    }
    let after: Cursor;
    let first: Event[];
    let head: Cursor;
    let more: boolean;
    try {
      after = frame.after ?? headCursor(handle);
      const replayed = replay(handle, after, { limit: REPLAY_PAGE });
      if (!replayed.ok) {
        this.#reply({ ok: false, requestId, error: replayed.error });
        return;
      }
      first = this.#server.renderer.renderAll(office, replayed.head.epoch, replayed.entries);
      head = first.at(-1)?.cursor ?? after;
      more = replayed.entries.length === REPLAY_PAGE;
    } catch (error) {
      this.#deps.logger.error("office replay failed", { office, error });
      this.#reply({
        ok: false,
        requestId,
        error: engineError("internal", "The engine could not replay this office stream."),
      });
      return;
    }
    this.#reply({ ok: true, requestId, result: { stream, from: after } });
    const subscription = this.#addSubscription(stream, office, filter, after);
    this.#deliver(subscription, first, head);
    try {
      if (more) this.#catchUpOffice(subscription, handle);
    } catch (error) {
      this.#deps.logger.error("office replay failed", { office, error });
      this.#close(CLOSE_POLICY_VIOLATION, "the office stream needs a reset; subscribe again");
      return;
    }
    this.#mark(subscription, true);
  }

  /** Sends every entry after the subscription's position; throws when the cursor needs a reset. */
  #catchUpOffice(subscription: Subscription, handle: OfficeHandle): void {
    const office = handle.officeId;
    for (;;) {
      const replayed = replay(handle, subscription.position, { limit: REPLAY_PAGE });
      if (!replayed.ok) throw new Error(replayed.error.message);
      if (replayed.entries.length === 0) return;
      const events = this.#server.renderer.renderAll(office, replayed.head.epoch, replayed.entries);
      const last = events.at(-1);
      if (last === undefined) return;
      this.#deliver(subscription, events, last.cursor);
      if (replayed.entries.length < REPLAY_PAGE) return;
    }
  }

  #addSubscription(
    stream: StreamName,
    office: OfficeId | null,
    filter: readonly string[],
    position: Cursor,
  ): Subscription {
    const subscription: Subscription = { stream, office, filter, position, heartbeat: null };
    this.#subscriptions.set(stream, subscription);
    this.#armHeartbeat(subscription);
    return subscription;
  }

  #dropSubscription(subscription: Subscription): void {
    this.#stopHeartbeat(subscription);
    if (this.#subscriptions.get(subscription.stream) === subscription) {
      this.#subscriptions.delete(subscription.stream);
    }
  }

  /** Sends the events the filter lets through and moves the position to `to`. */
  #deliver(subscription: Subscription, events: readonly Event[], to: Cursor): void {
    const { filter } = subscription;
    const kept =
      filter.length === 0
        ? events
        : events.filter((event) => !filter.some((prefix) => event.type.startsWith(prefix)));
    subscription.position = to;
    this.#sendEvents(subscription, kept);
  }

  #mark(subscription: Subscription, caughtUp: boolean): void {
    this.#sendEvents(subscription, [
      {
        cursor: subscription.position,
        at: this.#now(),
        type: "stream.mark",
        data: caughtUp ? { caughtUp: true } : {},
      },
    ]);
  }

  #sendEvents(subscription: Subscription, events: readonly Event[]): void {
    if (events.length === 0) return;
    for (let i = 0; i < events.length; i += EVENTS_PER_FRAME) {
      this.#send({ kind: "events", events: events.slice(i, i + EVENTS_PER_FRAME) });
    }
    this.#armHeartbeat(subscription);
  }

  /** (Re)arms the idle heartbeat: a `stream.mark` once nothing was sent for the interval. */
  #armHeartbeat(subscription: Subscription): void {
    if (this.#closed) return;
    this.#stopHeartbeat(subscription);
    const clock = this.#deps.clock;
    subscription.heartbeat = clock.setTimeout(() => {
      subscription.heartbeat = null;
      if (this.#closed || this.#subscriptions.get(subscription.stream) !== subscription) return;
      this.#mark(subscription, false);
    }, this.#server.heartbeatMs);
  }

  #stopHeartbeat(subscription: Subscription): void {
    if (subscription.heartbeat === null) return;
    this.#deps.clock.clearTimeout(subscription.heartbeat);
    subscription.heartbeat = null;
  }

  // Output

  #now(): string {
    return new Date(this.#deps.clock.now()).toISOString();
  }

  #reply(reply: CommandReply | ReadReply): void {
    this.#send({ kind: "reply", reply });
  }

  #send(frame: ServerFrame): void {
    if (this.#closed) return;
    this.#socket.send(JSON.stringify(frame));
  }

  #close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#socket.close(code, reason);
    this.closed();
  }
}
