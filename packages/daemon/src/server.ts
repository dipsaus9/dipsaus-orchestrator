// The contract on `dipo.sock` (0005). Each WebSocket text frame holds one `ClientFrame` or
// `ServerFrame`. A connection starts with the `engine.hello` read. Commands and reads go to the
// engine's surface, which runs the lifecycle checks (DIPO-318). `subscribe` replays the software ring buffer or an office
// change log after the client's cursor, marks the end of catch-up, then sends live events, with a
// `stream.mark` heartbeat on an idle subscription. The engine keeps no per-connection state beyond
// the subscriptions and the handshake. When the last TUI that follows an office stops following it
// (it closes, switches office or loses its connection), the server tells `tuiLeft`, which stores
// the time for `office.digest` (DIPO-308).
//
// One connection serves its frames side by side (DIPO-320): each read runs as soon as it arrives,
// keyed by its request id, so one slow read never holds a fast one or a command back. Commands
// start in the order they arrive. Only the subscribes and unsubscribes of one stream wait for each
// other, in order. Frames that arrive while `engine.hello` runs wait for it. Each read and
// subscribe has a deadline: past it the client gets `request.timedOut`, and the late answer is
// dropped, so a request gets one reply and a late subscribe opens no subscription. At most
// `MAX_IN_FLIGHT` reads and subscribes of one connection run at once; the next waits its turn.

import {
  argsInvalid,
  type Clock,
  type ClientFrame,
  type CommandReply,
  type Cursor,
  ClientFrame as ClientFrameSchema,
  type EngineError,
  engineError,
  type Event,
  OfficeId,
  type ReadReply,
  REQUEST_TIMED_OUT,
  RequestId,
  type ServerFrame,
  SOFTWARE_STREAM,
  type StreamName,
  type TimerHandle,
  TUI_CLIENT_NAME,
} from "@dipsaus-orchestrator/contract";
import type { EngineSurface, Logger, Presence } from "@dipsaus-orchestrator/engine";
import {
  CLOSE_INVALID_PAYLOAD,
  CLOSE_POLICY_VIOLATION,
  type ConnectionSession,
  type SocketConnection,
} from "@dipsaus-orchestrator/engine/platform";

/** An idle subscription gets a `stream.mark` this often (0005 section 8). */
export const HEARTBEAT_MS = 15_000;
/**
 * A read or subscribe that has not answered after this long answers `request.timedOut`
 * (DIPO-320). It is longer than one external call's deadline and its kill grace (60 s and 2 s,
 * DIPO-314), so a read that waits on one hung call gets that call's own error first.
 */
export const READ_DEADLINE_MS = 90_000;
/**
 * At most this many reads and subscribes of one connection run at once (DIPO-320); one more waits
 * until one of them ends, so a client cannot start unbounded work.
 */
export const MAX_IN_FLIGHT = 32;
/**
 * Office catch-up stops reading the change log while more than this many bytes wait to be
 * written to the client, and continues on the socket's drain; a slow client then costs at most
 * this plus one page, well under the backpressure limit.
 */
export const PUMP_HIGH_WATER_BYTES = 1024 * 1024;
/**
 * `office.summary` follows changes to an office at most this often (0005 section 5): the first
 * change starts the wait, and the summary then sent covers every change made during it.
 */
export const SUMMARY_DEBOUNCE_MS = 1_000;
/** At most this many events go in one `events` frame. */
export const EVENTS_PER_FRAME = 500;
/**
 * Office replay reads, renders and sends the change log in pages of this many entries, one frame
 * each, and checks for backpressure between pages (worker output entries are at most 16 KiB).
 */
const REPLAY_PAGE = 100;

export interface ContractServerDeps {
  /** The engine's surface: commands, reads and the streams (DIPO-318). */
  readonly engine: EngineSurface;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Called when the last TUI client of `office` disconnected, at `at` (DIPO-308): its last TUI
   * subscription to the office stream ended. The engine stores the time for `office.digest`.
   */
  readonly tuiLeft?: (office: OfficeId, at: number) => void;
  readonly heartbeatMs?: number;
  /** Office catch-up pauses while more than this many bytes wait to be written. */
  readonly pumpHighWaterBytes?: number;
  /** The deadline of each read and subscribe; `READ_DEADLINE_MS` by default. */
  readonly readDeadlineMs?: number;
  /** Reads and subscribes one connection runs at once; `MAX_IN_FLIGHT` by default. */
  readonly maxInFlight?: number;
}

interface Subscription {
  readonly stream: StreamName;
  readonly office: OfficeId | null;
  readonly filter: readonly string[];
  /** The last position the client has been brought to; marks repeat it. */
  position: Cursor;
  heartbeat: ReturnType<Clock["setTimeout"]> | null;
  /** True until the replay has reached the head and `stream.mark { caughtUp }` went out. */
  catchingUp: boolean;
}

/** `greeting` while the `engine.hello` read runs; frames that arrive then wait for it. */
type HandshakeState = "new" | "greeting" | "ready";

/** What a request under a deadline gave: its value, or null once the deadline answered it. */
type Answered<T> = { readonly value: T } | null;

function requestIdOf(raw: unknown): RequestId | null {
  if (typeof raw !== "object" || raw === null) return null;
  const parsed = RequestId.safeParse((raw as { requestId?: unknown }).requestId);
  return parsed.success ? parsed.data : null;
}

export class ContractServer {
  readonly #deps: ContractServerDeps;
  readonly #heartbeatMs: number;
  readonly #connections = new Set<Connection>();
  /** Offices whose summary is due, with the debounce timer that sends it. */
  readonly #summaryTimers = new Map<OfficeId, ReturnType<Clock["setTimeout"]>>();
  /** The last summary sent per office, so an unchanged one is not sent again. */
  readonly #lastSummaries = new Map<OfficeId, string>();
  /** `presence` as the listeners last heard it. */
  #tuiPresent = false;
  readonly #stopListening: readonly (() => void)[];
  readonly #presenceListeners = new Set<() => void>();

  constructor(deps: ContractServerDeps) {
    this.#deps = deps;
    this.#heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
    this.#stopListening = [
      deps.engine.onSoftwareEvent((event) => {
        for (const connection of this.#connections) connection.softwareEvent(event);
      }),
      // New entries in an office's change log, from a command or from a writer outside commands
      // (ingestion, reconcile): every subscriber of that office catches up.
      deps.engine.onOfficeChanged((office) => this.notifyOffice(office)),
    ];
  }

  get deps(): ContractServerDeps {
    return this.#deps;
  }

  get heartbeatMs(): number {
    return this.#heartbeatMs;
  }

  get pumpHighWaterBytes(): number {
    return this.#deps.pumpHighWaterBytes ?? PUMP_HIGH_WATER_BYTES;
  }

  get readDeadlineMs(): number {
    return this.#deps.readDeadlineMs ?? READ_DEADLINE_MS;
  }

  get maxInFlight(): number {
    return this.#deps.maxInFlight ?? MAX_IN_FLIGHT;
  }

  /** Open connections. */
  get connections(): number {
    return this.#connections.size;
  }

  /** Whether a TUI is connected right now, for live questions (0021 section 11, DIPO-279). */
  get presence(): Presence {
    return { tuiConnected: () => this.#tuiConnected() };
  }

  /**
   * Calls `listener` each time `presence` changes: when the first TUI's handshake is accepted and
   * when the last TUI's connection closes (DIPO-284). Returns the call that removes it.
   */
  onPresenceChanged(listener: () => void): () => void {
    this.#presenceListeners.add(listener);
    return () => this.#presenceListeners.delete(listener);
  }

  /** A connection became a TUI's or closed: tells the listeners when `presence` changed. */
  presenceMayHaveChanged(): void {
    const now = this.#tuiConnected();
    if (now === this.#tuiPresent) return;
    this.#tuiPresent = now;
    this.#deps.logger.debug("tui presence changed", { tuiConnected: now });
    for (const listener of this.#presenceListeners) {
      try {
        listener();
      } catch (error) {
        this.#deps.logger.warn("a presence listener failed", { error });
      }
    }
  }

  #tuiConnected(): boolean {
    return [...this.#connections].some((connection) => connection.tui);
  }

  /**
   * A TUI connection stopped following `offices`: for each one no other TUI follows, the office's
   * last TUI client has left (DIPO-308).
   */
  tuiLeftOffices(offices: readonly OfficeId[]): void {
    const tuiLeft = this.#deps.tuiLeft;
    if (tuiLeft === undefined) return;
    for (const office of new Set(offices)) {
      const followed = [...this.#connections].some(
        (connection) => connection.tui && connection.follows(office),
      );
      if (followed) continue;
      try {
        tuiLeft(office, this.#deps.clock.now());
      } catch (error) {
        this.#deps.logger.warn("storing when the last TUI left an office failed", {
          office,
          error,
        });
      }
    }
  }

  /** The session for one accepted connection; `serveUnixSocket` calls it. */
  accept(socket: SocketConnection): ConnectionSession {
    const connection = new Connection(this, socket, () => {
      this.#connections.delete(connection);
      this.#deps.logger.debug("connection closed", { connections: this.#connections.size });
      this.presenceMayHaveChanged();
    });
    this.#connections.add(connection);
    this.#deps.logger.debug("connection opened", { connections: this.#connections.size });
    return connection;
  }

  /**
   * New entries in `office`'s change log: every subscriber of that office catches up from its
   * position. The engine tells it after each transaction that wrote entries.
   */
  notifyOffice(office: OfficeId): void {
    for (const connection of this.#connections) connection.officeChanged(office);
    this.#scheduleSummary(office);
  }

  /**
   * Sends `office.summary` for `office` to every software subscriber once the debounce wait ends,
   * when it differs from the last one sent (0005 section 5: derived, debounced on change).
   */
  #scheduleSummary(office: OfficeId): void {
    if (this.#summaryTimers.has(office)) return;
    const clock = this.#deps.clock;
    const timer = clock.setTimeout(() => {
      this.#summaryTimers.delete(office);
      let summary;
      try {
        summary = this.#deps.engine.officeSummary(office);
      } catch (error) {
        this.#deps.logger.warn("office summary failed", { office, error });
        return;
      }
      if (summary === undefined) return;
      const text = JSON.stringify(summary);
      if (this.#lastSummaries.get(office) === text) return;
      this.#lastSummaries.set(office, text);
      for (const connection of this.#connections)
        connection.derivedSoftware("office.summary", summary);
    }, SUMMARY_DEBOUNCE_MS);
    this.#summaryTimers.set(office, timer);
  }

  /** Stops pending summary timers and the engine's events; a closing daemon sends no more. */
  close(): void {
    for (const stop of this.#stopListening) stop();
    for (const timer of this.#summaryTimers.values()) this.#deps.clock.clearTimeout(timer);
    this.#summaryTimers.clear();
  }
}

class Connection implements ConnectionSession {
  readonly #server: ContractServer;
  readonly #socket: SocketConnection;
  readonly #onClosed: () => void;
  #state: HandshakeState = "new";
  #closed = false;
  /** True once an `engine.hello` from the TUI was accepted on this connection. */
  #tui = false;
  /** The client name its `engine.hello` gave, carried into each command's context (DIPO-155). */
  #client: string | undefined;
  readonly #subscriptions = new Map<StreamName, Subscription>();
  /** Frames that arrived while `engine.hello` ran, taken in order once it answered. */
  #held: string[] = [];
  /** The deadline timer of each read and subscribe that has not answered, by request id. */
  readonly #inFlight = new Map<RequestId, TimerHandle>();
  /** Reads and subscribes whose engine work has not ended, timed out or not: the cap counts these. */
  #running = 0;
  /** Reads and subscribes waiting for room under the cap, in arrival order. */
  #waiting: { readonly requestId: RequestId; readonly start: () => void }[] = [];
  /** Per stream, the last subscribe or unsubscribe; the next one on that stream waits for it. */
  readonly #streamQueues = new Map<StreamName, Promise<void>>();

  constructor(server: ContractServer, socket: SocketConnection, onClosed: () => void) {
    this.#server = server;
    this.#socket = socket;
    this.#onClosed = onClosed;
  }

  get #deps(): ContractServerDeps {
    return this.#server.deps;
  }

  /** True while this open connection is a TUI's. */
  get tui(): boolean {
    return this.#tui && !this.#closed;
  }

  /** True while this connection follows the office stream of `office`. */
  follows(office: OfficeId): boolean {
    return [...this.#subscriptions.values()].some((subscription) => subscription.office === office);
  }

  message(text: string): void {
    if (this.#closed) return;
    if (this.#state === "greeting") {
      this.#held.push(text);
      return;
    }
    this.#handle(text);
  }

  closed(): void {
    if (this.#closed) return;
    const followed = this.#tui ? this.#followedOffices() : [];
    this.#closed = true;
    for (const subscription of this.#subscriptions.values()) this.#stopHeartbeat(subscription);
    this.#subscriptions.clear();
    for (const timer of this.#inFlight.values()) this.#deps.clock.clearTimeout(timer);
    this.#inFlight.clear();
    this.#waiting = [];
    this.#held = [];
    this.#onClosed();
    if (followed.length > 0) this.#server.tuiLeftOffices(followed);
  }

  #followedOffices(): OfficeId[] {
    return [...this.#subscriptions.values()].flatMap((subscription) =>
      subscription.office === null ? [] : [subscription.office],
    );
  }

  softwareEvent(event: Event): void {
    const subscription = this.#subscriptions.get(SOFTWARE_STREAM);
    if (subscription === undefined) return;
    this.#deliver(subscription, [event], event.cursor);
  }

  /** A derived software event (not stored, cursor repeats the position) to a software subscriber. */
  derivedSoftware(type: string, data: unknown): void {
    const subscription = this.#subscriptions.get(SOFTWARE_STREAM);
    if (subscription === undefined || this.#closed) return;
    this.#sendEvents(subscription, [
      { cursor: subscription.position, at: this.#now(), type, data },
    ]);
  }

  officeChanged(office: OfficeId): void {
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.office === office) this.#pumpOffice(subscription);
    }
  }

  /** The socket wrote what was queued: continue every office stream from its position. */
  drain(): void {
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.office !== null) this.#pumpOffice(subscription);
    }
  }

  // Frames

  #handle(text: string): void {
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
    // Names and ids only: args stay out of the log at every level (0006 decision 13).
    this.#deps.logger.debug("frame received", {
      kind: frame.kind,
      ...("name" in frame ? { name: frame.name } : {}),
      ...("stream" in frame ? { stream: frame.stream } : {}),
      ...("requestId" in frame ? { requestId: frame.requestId } : {}),
    });
    if (this.#state === "new") {
      this.#handshake(frame);
      return;
    }
    this.#ready(frame);
  }

  /**
   * The first frame must be the `engine.hello` read (0006 decision 9). While it runs, later frames
   * wait; once it answered they are taken in order, as the first frames of a ready connection or,
   * when the hello failed, of a new one.
   */
  #handshake(frame: ClientFrame): void {
    if (frame.kind === "read" && frame.name === "engine.hello") {
      this.#state = "greeting";
      void this.#withDeadline(frame.requestId, "read", frame.name, (answeredWithout) =>
        this.#read(frame, answeredWithout),
      ).then((answered) => {
        if (this.#closed) return;
        const reply = answered?.value;
        if (reply?.ok === true) {
          this.#state = "ready";
          this.#tui = isTuiHello(frame.args);
          this.#client = helloClient(frame.args);
          if (this.#tui) this.#server.presenceMayHaveChanged();
        } else {
          this.#state = "new";
        }
        if (reply !== undefined) this.#reply(reply);
        const held = this.#held;
        this.#held = [];
        for (const text of held) this.message(text);
      });
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

  /** Starts one frame of a ready connection; nothing here waits for an earlier frame. */
  #ready(frame: ClientFrame): void {
    switch (frame.kind) {
      case "read": {
        void this.#withDeadline(frame.requestId, "read", frame.name, (answeredWithout) =>
          this.#read(frame, answeredWithout),
        ).then((answered) => {
          if (answered !== null) this.#reply(answered.value);
        });
        return;
      }
      case "command":
        this.#command(frame);
        return;
      case "subscribe":
        this.#inStreamOrder(frame.stream, () => this.#subscribe(frame));
        return;
      case "unsubscribe":
        this.#inStreamOrder(frame.stream, async () => {
          const subscription = this.#subscriptions.get(frame.stream);
          if (subscription !== undefined) this.#dropSubscription(subscription);
        });
        return;
    }
  }

  /**
   * Asks the engine for one read. `answeredWithout` settles when the client got `request.timedOut`
   * instead, so the engine's request line names what the client got (DIPO-320).
   */
  async #read(
    frame: Extract<ClientFrame, { kind: "read" }>,
    answeredWithout: Promise<EngineError>,
  ): Promise<ReadReply> {
    const { requestId, name, args } = frame;
    return this.#deps.engine.executeRead({ requestId, name, args }, { answeredWithout });
  }

  /**
   * Runs `run` under the read deadline and the cap on work in flight (DIPO-320), keyed by
   * `requestId`. Past the deadline the client gets `request.timedOut`, `answeredWithout` settles
   * with that error and this resolves null; the late answer is dropped. A `run` that throws
   * answers `internal`, and an id whose earlier read or subscribe is still running or waiting on
   * this connection `request.reused`; both resolve null too. The caller sends the reply of a
   * value, so each id gets exactly one reply. Past `maxInFlight` runs at once, a request waits its
   * turn in arrival order, and its deadline starts when it runs.
   */
  #withDeadline<T>(
    requestId: RequestId,
    kind: "read" | "subscribe",
    name: string,
    run: (answeredWithout: Promise<EngineError>) => Promise<T>,
  ): Promise<Answered<T>> {
    if (this.#inFlight.has(requestId) || this.#waiting.some((w) => w.requestId === requestId)) {
      this.#reply({
        ok: false,
        requestId,
        error: engineError(
          "request.reused",
          `A ${kind} with this request id is still running on this connection; send a new request id.`,
        ),
      });
      return Promise.resolve(null);
    }
    const { promise, resolve } = Promise.withResolvers<Answered<T>>();
    const start = () => this.#runWithDeadline(requestId, name, run, resolve);
    if (this.#running < this.#server.maxInFlight) start();
    else this.#waiting.push({ requestId, start });
    return promise;
  }

  #runWithDeadline<T>(
    requestId: RequestId,
    name: string,
    run: (answeredWithout: Promise<EngineError>) => Promise<T>,
    resolve: (answered: Answered<T>) => void,
  ): void {
    const deadlineMs = this.#server.readDeadlineMs;
    const timedOut = Promise.withResolvers<EngineError>();
    const finish = (): boolean => {
      const timer = this.#inFlight.get(requestId);
      if (timer === undefined) return false;
      this.#deps.clock.clearTimeout(timer);
      this.#inFlight.delete(requestId);
      return true;
    };
    const timer = this.#deps.clock.setTimeout(() => {
      if (!finish()) return;
      const error = engineError(
        REQUEST_TIMED_OUT,
        `${name} did not answer within its deadline of ${Math.round(deadlineMs / 1000)} s.`,
        { name, deadlineMs },
      );
      this.#deps.logger.warn("a read passed its deadline", { name, requestId, deadlineMs });
      timedOut.resolve(error);
      this.#reply({ ok: false, requestId, error });
      resolve(null);
    }, deadlineMs);
    this.#inFlight.set(requestId, timer);
    // The slot is held until the engine's work ends, also past the deadline: the cap bounds work.
    this.#running += 1;
    const settled = () => {
      this.#running -= 1;
      this.#startWaiting();
    };
    (async () => run(timedOut.promise))().then(
      (value) => {
        settled();
        resolve(finish() ? { value } : null);
      },
      (error: unknown) => {
        settled();
        if (!finish()) return resolve(null);
        this.#deps.logger.error("a read failed", { name, requestId, error });
        this.#reply({
          ok: false,
          requestId,
          error: engineError("internal", "The engine failed while handling this request."),
        });
        resolve(null);
      },
    );
  }

  /** Starts the waiting reads and subscribes while the cap leaves room, oldest first. */
  #startWaiting(): void {
    while (!this.#closed && this.#running < this.#server.maxInFlight) {
      const next = this.#waiting.shift();
      if (next === undefined) return;
      next.start();
    }
  }

  /** Runs `step` after the earlier subscribes and unsubscribes of `stream` on this connection. */
  #inStreamOrder(stream: StreamName, step: () => Promise<void>): void {
    const previous = this.#streamQueues.get(stream) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.#closed) return;
      try {
        await step();
      } catch (error) {
        this.#deps.logger.error("a stream request failed", { stream, error });
      }
    });
    this.#streamQueues.set(stream, next);
    void next.then(() => {
      if (this.#streamQueues.get(stream) === next) this.#streamQueues.delete(stream);
    });
  }

  /** Runs one command alongside later frames; its reply may come after theirs (0005 section 3). */
  #command(frame: Extract<ClientFrame, { kind: "command" }>): void {
    const { kind: _kind, ...request } = frame;
    // The engine sends the reply here before the office's subscribers hear the new entries.
    void this.#deps.engine.executeCommand(
      request,
      this.#client === undefined ? {} : { client: this.#client },
      (reply: CommandReply) => this.#reply(reply),
    );
  }

  // Streams

  async #subscribe(frame: Extract<ClientFrame, { kind: "subscribe" }>): Promise<void> {
    const { requestId, stream } = frame;
    const filter = frame.filter ?? [];
    const previous = this.#subscriptions.get(stream);
    // Subscribing again to the same stream does not leave it.
    if (previous !== undefined) this.#dropSubscription(previous, false);

    // A subscribe past its deadline answered `request.timedOut` already: its late answer opens
    // nothing.
    const answered = await this.#withDeadline(requestId, "subscribe", `subscribe ${stream}`, () =>
      this.#deps.engine.subscribe(stream, frame.after),
    );
    if (answered === null || this.#closed) return;
    const subscribed = answered.value;
    if (!subscribed.ok) {
      this.#reply({ ok: false, requestId, error: subscribed.error });
      return;
    }
    this.#reply({ ok: true, requestId, result: { stream, from: subscribed.from } });
    const subscription = this.#addSubscription(stream, subscribed.office, filter, subscribed.from);
    if (subscribed.office === null) {
      this.#deliver(subscription, subscribed.events, subscribed.head);
      this.#mark(subscription, true);
      // Derived: the current summary of every office after catch-up (0005 section 5).
      const summaries = this.#deps.engine.officeSummaries().map((summary) => ({
        cursor: subscription.position,
        at: this.#now(),
        type: "office.summary",
        data: summary,
      }));
      this.#sendEvents(subscription, summaries);
      return;
    }
    subscription.catchingUp = true;
    this.#pumpOffice(subscription);
  }

  /**
   * Sends the office entries after the subscription's position, one page per frame, and stops
   * while more than `PUMP_HIGH_WATER_BYTES` wait to be written (`drain` resumes it) or once the
   * connection is closed, so a slow client never makes the daemon read and render the whole log
   * at once. At the head it ends the catch-up with `stream.mark { caughtUp: true }`. A cursor that
   * can no longer be replayed (a restored office) closes the connection; the client subscribes
   * again. A stored entry that does not render is logged and sent as an `engine.notice` at its own
   * cursor, so the position moves past it and no client replays it for good (DIPO-124).
   */
  #pumpOffice(subscription: Subscription): void {
    const office = subscription.office;
    if (office === null) return;
    try {
      while (!this.#closed && this.#socket.buffered() < this.#server.pumpHighWaterBytes) {
        const page = this.#deps.engine.officePage(office, subscription.position, REPLAY_PAGE);
        if (page.kind === "gone") {
          this.#dropSubscription(subscription);
          return;
        }
        const events = page.events;
        const last = events.at(-1);
        if (last !== undefined) this.#deliver(subscription, events, last.cursor);
        if (page.last) {
          if (subscription.catchingUp && !this.#closed) {
            subscription.catchingUp = false;
            this.#mark(subscription, true);
          }
          return;
        }
      }
    } catch (error) {
      this.#deps.logger.error("office stream delivery failed", { office, error });
      this.#close(CLOSE_POLICY_VIOLATION, "the office stream needs a reset; subscribe again");
    }
  }

  #addSubscription(
    stream: StreamName,
    office: OfficeId | null,
    filter: readonly string[],
    position: Cursor,
  ): Subscription {
    const subscription: Subscription = {
      stream,
      office,
      filter,
      position,
      heartbeat: null,
      catchingUp: false,
    };
    this.#subscriptions.set(stream, subscription);
    this.#armHeartbeat(subscription);
    return subscription;
  }

  /** Ends a subscription; a TUI that `leaves` an office stream may be the office's last (DIPO-308). */
  #dropSubscription(subscription: Subscription, leaves = true): void {
    this.#stopHeartbeat(subscription);
    if (this.#subscriptions.get(subscription.stream) === subscription) {
      this.#subscriptions.delete(subscription.stream);
    }
    if (leaves && this.#tui && !this.#closed && subscription.office !== null) {
      this.#server.tuiLeftOffices([subscription.office]);
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
    for (let i = 0; i < events.length && !this.#closed; i += EVENTS_PER_FRAME) {
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
    // A dropped frame means the connection is closing (a slow client past the backpressure
    // limit): stop here; the client reconnects and replays from its last cursor (0005 section 8).
    if (this.#socket.send(JSON.stringify(frame)) === "dropped") this.closed();
  }

  #close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#socket.close(code, reason);
    this.closed();
  }
}

/**
 * True when `engine.hello` args name the TUI as the client. Any client on the socket can claim the
 * name; that only keeps a question live until its timeout, and holds while workers cannot reach the
 * socket (0021).
 */
/** The client name `engine.hello` args give, or undefined. */
function helloClient(args: unknown): string | undefined {
  const name = (args as { client?: { name?: unknown } } | null)?.client?.name;
  return typeof name === "string" && name !== "" ? name : undefined;
}

function isTuiHello(args: unknown): boolean {
  const client = (args as { client?: { name?: unknown } } | null)?.client;
  return client?.name === TUI_CLIENT_NAME;
}
