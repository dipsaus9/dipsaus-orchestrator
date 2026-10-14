// The runtime-free protocol core (0005 sections 3, 8 and 9; 0009 section 7). One connection per
// client carries everything. Each connection starts with the `engine.hello` read; replies are
// matched by `requestId` in any order; events are routed by `cursor.stream`. After a lost
// connection the client reconnects with backoff (0.5 s doubling to 5 s) on the injected clock,
// sends `engine.hello` again, re-subscribes after the last cursor it has, and re-sends every
// unanswered command and read with its original `requestId`, which is safe because the engine
// stores commands by `requestId` (0005 section 9). Stored events whose cursor the client already
// has are dropped; derived events are exempt (0005 section 8).

import type { z } from "zod";

import {
  type ClientFrame,
  type Clock,
  type CommandDefinition,
  type CommandReply,
  CONTRACT_VERSION,
  type Cursor,
  type EngineError,
  engineHello,
  type Event,
  findEvent,
  type OfficeId,
  type Origin,
  type ReadDefinition,
  type ReadReply,
  type RequestId,
  ServerFrame,
  type StreamName,
  SubscribeResult,
  type TimerHandle,
} from "@dipsaus-orchestrator/contract";

import { type RequestIds, ulidRequestIds } from "./request-id";
import type { Transport, TransportConnection } from "./transport";

/** The first reconnect waits this long; each failed attempt doubles it (0009 section 7). */
export const RECONNECT_INITIAL_MS = 500;
/** Reconnect attempts never wait longer than this. */
export const RECONNECT_MAX_MS = 5_000;
/** How long the first connection may take to answer `engine.hello`. */
export const CONNECT_TIMEOUT_MS = 5_000;
/** The daemon sends a `stream.mark` on an idle subscription this often (0005 section 8). */
export const STREAM_MARK_MS = 15_000;
/**
 * While subscribed, a connection with no frame for this long (three idle `stream.mark` intervals)
 * is taken as hung: the client closes it and reconnects (DIPO-52).
 */
export const LIVENESS_MS = 3 * STREAM_MARK_MS;

/** The wait before reconnect attempt `attempt` (0 for the first attempt after a disconnect). */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * 2 ** Math.max(0, attempt));
}

export type HelloResult = z.output<typeof engineHello.result>;

/**
 * `idle` before `connect`; `connecting` until the first `engine.hello` reply; `open` while a
 * connection is ready; `reconnecting` between a lost connection and the next ready one; `closed`
 * after `close` or a failure that ends the client.
 */
export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/**
 * Codes of failures on the client side, never sent by the engine: `client.unreachable` (the first
 * connection failed), `client.closed` (the client closed with the request unanswered),
 * `client.invalidArgs` (the args do not match the contract schema) and `client.invalidReply` (a
 * reply does not match it). A failed `engine.hello` keeps the engine's code, such as
 * `contract.unsupported`, and carries the engine error.
 */
export class ClientError extends Error {
  readonly code: string;
  readonly engineError: EngineError | undefined;

  constructor(code: string, message: string, engineError?: EngineError) {
    super(message);
    this.name = "ClientError";
    this.code = code;
    this.engineError = engineError;
  }
}

export type CommandOutcome<R> =
  | { readonly ok: true; readonly result: R; readonly changed: boolean; readonly cursor?: Cursor }
  | { readonly ok: false; readonly error: EngineError };

export type ReadOutcome<R> =
  | { readonly ok: true; readonly result: R }
  | { readonly ok: false; readonly error: EngineError };

export interface CommandOptions extends RequestOptions {
  /** Required on office-level commands (0005 section 3). */
  readonly office?: OfficeId;
  /** Set only after the maintainer agreed (0005 section 9). */
  readonly confirmed?: boolean;
}

export interface RequestOptions {
  /**
   * How long the request may wait for its reply once sent. Past it the connection is taken as
   * hung: the client closes it, reconnects and sends the request again with its `requestId`
   * (DIPO-52). None by default, since a command such as `work.run` may wait minutes.
   */
  readonly deadlineMs?: number;
}

export interface SubscribeOptions {
  /** Replay starts after this cursor; without it the stream starts at its head. */
  readonly after?: Cursor;
  /** Event type prefixes the daemon leaves out. */
  readonly filter?: readonly string[];
  /** Every event of the stream, `stream.mark` included, without duplicates. */
  readonly onEvent: (event: Event) => void;
  /** A `stream.mark { caughtUp: true }` arrived: replay is done and live events follow. */
  readonly onCaughtUp?: (cursor: Cursor) => void;
  /**
   * The daemon refused the subscription, for example `stream.resetRequired` after a daemon
   * restart or a history gap. The subscription has ended; the caller re-reads and subscribes again.
   */
  readonly onEnded?: (error: EngineError) => void;
}

export interface Subscription {
  readonly stream: StreamName;
  /** The last stored event's cursor the client has, or the subscribe reply's `from`. */
  readonly cursor: Cursor | undefined;
  unsubscribe(): void;
}

export interface ClientOptions {
  readonly transport: Transport;
  readonly clock: Clock;
  /** Sent in `engine.hello`. */
  readonly client: { readonly name: string; readonly version: string };
  /** Sent on every command (0005 section 3). */
  readonly origin: Origin;
  readonly requestIds?: RequestIds;
  /** No frame for this long while subscribed closes the connection; `LIVENESS_MS` by default. */
  readonly livenessMs?: number;
}

interface Pending {
  readonly frame: ClientFrame;
  readonly settle: (reply: CommandReply | ReadReply) => void;
  readonly fail: (error: ClientError) => void;
  readonly deadlineMs: number | undefined;
  /** When the frame was last sent on a ready connection; null while it waits for one. */
  sentAt: number | null;
}

interface Stream {
  readonly stream: StreamName;
  readonly filter: readonly string[] | undefined;
  readonly options: SubscribeOptions;
  last: Cursor | undefined;
  requestId: RequestId | null;
  active: boolean;
}

export class DipoClient {
  readonly #transport: Transport;
  readonly #clock: Clock;
  readonly #client: { readonly name: string; readonly version: string };
  readonly #origin: Origin;
  readonly #newId: RequestIds;

  #state: ConnectionState = "idle";
  #connection: TransportConnection | null = null;
  /** Bumped for every connection; events from an older one are ignored. */
  #generation = 0;
  #helloId: RequestId | null = null;
  #ready = false;
  #hello: HelloResult | null = null;
  #attempt = 0;
  #timer: TimerHandle | null = null;
  #first: { resolve: (hello: HelloResult) => void; reject: (error: ClientError) => void } | null =
    null;
  readonly #pending = new Map<RequestId, Pending>();
  readonly #streams = new Map<StreamName, Stream>();
  readonly #stateListeners = new Set<(state: ConnectionState) => void>();
  readonly #livenessMs: number;
  /** When the current connection last delivered a frame. */
  #lastFrameAt = 0;
  #liveness: { readonly timer: TimerHandle; readonly due: number } | null = null;

  constructor(options: ClientOptions) {
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#client = options.client;
    this.#origin = options.origin;
    this.#newId = options.requestIds ?? ulidRequestIds(options.clock);
    this.#livenessMs = options.livenessMs ?? LIVENESS_MS;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** The latest `engine.hello` result; replaced on every reconnect. */
  get hello(): HelloResult | null {
    return this.#hello;
  }

  /** Calls `listener` on every state change; returns a function that stops it. */
  onState(listener: (state: ConnectionState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /**
   * Opens the first connection and resolves with the `engine.hello` result. It rejects with
   * `client.unreachable` when the connection fails or the daemon does not answer within
   * `timeoutMs`, and with the engine's code when `engine.hello` fails; the client is then closed.
   * Later losses reconnect on their own.
   */
  connect(options: { readonly timeoutMs?: number } = {}): Promise<HelloResult> {
    if (this.#state !== "idle") {
      return Promise.reject(new ClientError("client.closed", "connect may be called only once"));
    }
    const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = this.#clock.setTimeout(() => {
        this.#end(new ClientError("client.unreachable", "The daemon did not answer in time."));
      }, timeoutMs);
      this.#first = {
        resolve: (hello) => {
          this.#clock.clearTimeout(timer);
          resolve(hello);
        },
        reject: (error) => {
          this.#clock.clearTimeout(timer);
          reject(error);
        },
      };
      this.#setState("connecting");
      this.#open();
    });
  }

  /** Sends a command and resolves with its reply; an engine error is a value, not a throw. */
  command<A extends z.ZodType, R extends z.ZodType>(
    definition: CommandDefinition<string, A, R>,
    args: z.input<A>,
    options: CommandOptions = {},
  ): Promise<CommandOutcome<z.output<R>>> {
    const parsed = definition.args.safeParse(args);
    if (!parsed.success) {
      return Promise.reject(
        new ClientError("client.invalidArgs", `Invalid args for ${definition.name}.`),
      );
    }
    const requestId = this.#newId();
    const frame: ClientFrame = {
      kind: "command",
      requestId,
      name: definition.name,
      args: parsed.data,
      origin: this.#origin,
      confirmed: options.confirmed ?? false,
      ...(options.office === undefined ? {} : { office: options.office }),
    };
    return this.#request(frame, options.deadlineMs).then((reply) => {
      if (!reply.ok) return { ok: false, error: reply.error };
      const result = definition.result.safeParse(reply.result);
      if (!("changed" in reply) || !result.success) {
        throw new ClientError(
          "client.invalidReply",
          `The reply to ${definition.name} does not match the contract.`,
        );
      }
      return reply.cursor === undefined
        ? { ok: true, result: result.data, changed: reply.changed }
        : { ok: true, result: result.data, changed: reply.changed, cursor: reply.cursor };
    });
  }

  /** Sends a read and resolves with its reply; an engine error is a value, not a throw. */
  read<A extends z.ZodType, R extends z.ZodType>(
    definition: ReadDefinition<string, A, R>,
    args: z.input<A>,
    options: RequestOptions = {},
  ): Promise<ReadOutcome<z.output<R>>> {
    const parsed = definition.args.safeParse(args);
    if (!parsed.success) {
      return Promise.reject(
        new ClientError("client.invalidArgs", `Invalid args for ${definition.name}.`),
      );
    }
    const frame: ClientFrame = {
      kind: "read",
      requestId: this.#newId(),
      name: definition.name,
      args: parsed.data,
    };
    return this.#request(frame, options.deadlineMs).then((reply) => {
      if (!reply.ok) return { ok: false, error: reply.error };
      const result = definition.result.safeParse(reply.result);
      if (!result.success) {
        throw new ClientError(
          "client.invalidReply",
          `The reply to ${definition.name} does not match the contract.`,
        );
      }
      return { ok: true, result: result.data };
    });
  }

  /**
   * Subscribes to one stream; one subscription per stream, a second replaces the first. It is
   * sent now when the client is open and again after every reconnect, after the last cursor.
   */
  subscribe(stream: StreamName, options: SubscribeOptions): Subscription {
    if (this.#state === "closed") throw new ClientError("client.closed", "The client is closed.");
    const previous = this.#streams.get(stream);
    if (previous !== undefined) previous.active = false;
    const entry: Stream = {
      stream,
      filter: options.filter,
      options,
      last: options.after,
      requestId: null,
      active: true,
    };
    this.#streams.set(stream, entry);
    if (this.#ready) {
      this.#sendSubscribe(entry);
      this.#armLiveness();
    }
    return {
      stream,
      get cursor() {
        return entry.last;
      },
      unsubscribe: () => {
        if (!entry.active) return;
        entry.active = false;
        if (this.#streams.get(stream) === entry) this.#streams.delete(stream);
        if (this.#ready) this.#send({ kind: "unsubscribe", stream });
      },
    };
  }

  /** Closes the connection and stops reconnecting; unanswered requests fail with `client.closed`. */
  close(): void {
    this.#end(new ClientError("client.closed", "The client was closed."));
  }

  // Connection

  #open(): void {
    const generation = ++this.#generation;
    const helloId = this.#newId();
    this.#helloId = helloId;
    this.#ready = false;
    const current = () => generation === this.#generation && this.#state !== "closed";
    this.#connection = this.#transport.connect({
      onOpen: () => {
        if (!current()) return;
        this.#send({
          kind: "read",
          requestId: helloId,
          name: engineHello.name,
          args: { contract: CONTRACT_VERSION, client: this.#client },
        });
      },
      onMessage: (text) => {
        if (current()) this.#message(text);
      },
      onClose: () => {
        if (current()) this.#lost();
      },
    });
  }

  /**
   * The connection is taken as hung (no frame within the liveness window, or a request past its
   * deadline): close it and reconnect as after a loss, without waiting for the transport to notice.
   */
  #hung(): void {
    const connection = this.#connection;
    this.#generation += 1;
    connection?.close();
    this.#lost();
  }

  #lost(): void {
    this.#connection = null;
    this.#ready = false;
    this.#stopLiveness();
    if (this.#first !== null) {
      this.#end(new ClientError("client.unreachable", "Cannot reach the daemon."));
      return;
    }
    this.#setState("reconnecting");
    const delay = reconnectDelay(this.#attempt);
    this.#attempt += 1;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      if (this.#state === "reconnecting") this.#open();
    }, delay);
  }

  #message(text: string): void {
    let parsed: ReturnType<typeof ServerFrame.safeParse>;
    try {
      parsed = ServerFrame.safeParse(JSON.parse(text));
    } catch {
      return;
    }
    if (!parsed.success) return;
    this.#lastFrameAt = this.#clock.now();
    const frame = parsed.data;
    if (frame.kind === "events") {
      if (this.#ready) for (const event of frame.events) this.#route(event);
      return;
    }
    const reply = frame.reply;
    if (!this.#ready) {
      if (reply.requestId === this.#helloId) this.#helloReply(reply);
      return;
    }
    const pending = this.#pending.get(reply.requestId);
    if (pending !== undefined) {
      this.#pending.delete(reply.requestId);
      pending.settle(reply);
      return;
    }
    for (const entry of this.#streams.values()) {
      if (entry.requestId === reply.requestId) {
        this.#subscribeReply(entry, reply);
        return;
      }
    }
  }

  #helloReply(reply: CommandReply | ReadReply): void {
    if (!reply.ok) {
      this.#end(new ClientError(reply.error.code, reply.error.message, reply.error));
      return;
    }
    const hello = engineHello.result.safeParse(reply.result);
    if (!hello.success) {
      this.#end(
        new ClientError(
          "client.invalidReply",
          "The engine.hello reply does not match the contract.",
        ),
      );
      return;
    }
    this.#hello = hello.data;
    this.#ready = true;
    this.#attempt = 0;
    this.#setState("open");
    const first = this.#first;
    this.#first = null;
    first?.resolve(hello.data);
    for (const entry of this.#streams.values()) this.#sendSubscribe(entry);
    for (const pending of this.#pending.values()) this.#sendPending(pending);
    this.#armLiveness();
  }

  #end(error: ClientError): void {
    if (this.#state === "closed") return;
    this.#generation += 1;
    this.#ready = false;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#stopLiveness();
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#setState("closed");
    const first = this.#first;
    this.#first = null;
    first?.reject(error);
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) request.fail(error);
    for (const entry of this.#streams.values()) entry.active = false;
    this.#streams.clear();
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }

  // Requests

  #request(
    frame: ClientFrame & { requestId: RequestId },
    deadlineMs: number | undefined,
  ): Promise<CommandReply | ReadReply> {
    if (this.#state === "closed") {
      return Promise.reject(new ClientError("client.closed", "The client is closed."));
    }
    return new Promise((settle, fail) => {
      const pending: Pending = { frame, settle, fail, deadlineMs, sentAt: null };
      this.#pending.set(frame.requestId, pending);
      if (this.#ready) {
        this.#sendPending(pending);
        this.#armLiveness();
      }
    });
  }

  #sendPending(pending: Pending): void {
    pending.sentAt = this.#clock.now();
    this.#send(pending.frame);
  }

  // Liveness (DIPO-52, 0005 section 8): an idle subscription gets a `stream.mark` every 15 s, so
  // no frame for `livenessMs` while subscribed, or a request past its deadline, means the daemon
  // hangs; the connection is closed and the client reconnects.

  /** The earliest time the open connection is taken as hung, or null when nothing waits. */
  #nextDeadline(): number | null {
    if (!this.#ready) return null;
    let next: number | null = null;
    const earlier = (at: number) => {
      next = next === null ? at : Math.min(next, at);
    };
    for (const entry of this.#streams.values()) {
      if (entry.active) {
        earlier(this.#lastFrameAt + this.#livenessMs);
        break;
      }
    }
    for (const pending of this.#pending.values()) {
      if (pending.deadlineMs !== undefined && pending.sentAt !== null) {
        // A request is answered in time when its reply or any later frame arrives.
        earlier(Math.max(pending.sentAt, this.#lastFrameAt) + pending.deadlineMs);
      }
    }
    return next;
  }

  /** Arms the liveness timer for the next deadline, or earlier when one moved closer. */
  #armLiveness(): void {
    const due = this.#nextDeadline();
    if (due === null) return;
    if (this.#liveness !== null) {
      if (this.#liveness.due <= due) return;
      this.#clock.clearTimeout(this.#liveness.timer);
    }
    const timer = this.#clock.setTimeout(
      () => {
        this.#liveness = null;
        const next = this.#nextDeadline();
        if (next === null) return;
        if (this.#clock.now() >= next) this.#hung();
        else this.#armLiveness();
      },
      Math.max(0, due - this.#clock.now()),
    );
    this.#liveness = { timer, due };
  }

  #stopLiveness(): void {
    if (this.#liveness !== null) this.#clock.clearTimeout(this.#liveness.timer);
    this.#liveness = null;
  }

  #send(frame: ClientFrame): void {
    this.#connection?.send(JSON.stringify(frame));
  }

  // Streams

  #sendSubscribe(entry: Stream): void {
    const requestId = this.#newId();
    entry.requestId = requestId;
    this.#send({
      kind: "subscribe",
      requestId,
      stream: entry.stream,
      ...(entry.last === undefined ? {} : { after: entry.last }),
      ...(entry.filter === undefined ? {} : { filter: [...entry.filter] }),
    });
  }

  #subscribeReply(entry: Stream, reply: CommandReply | ReadReply): void {
    entry.requestId = null;
    if (!reply.ok) {
      entry.active = false;
      if (this.#streams.get(entry.stream) === entry) this.#streams.delete(entry.stream);
      entry.options.onEnded?.(reply.error);
      return;
    }
    const result = SubscribeResult.safeParse(reply.result);
    if (result.success && entry.last === undefined) entry.last = result.data.from;
  }

  #route(event: Event): void {
    const entry = this.#streams.get(event.cursor.stream);
    if (entry === undefined || !entry.active) return;
    const derived = findEvent(event.type)?.derived ?? false;
    if (!derived) {
      const last = entry.last;
      if (last !== undefined && last.epoch === event.cursor.epoch && event.cursor.seq <= last.seq) {
        return; // already delivered: at-least-once delivery (0005 section 8)
      }
      entry.last = event.cursor;
    }
    entry.options.onEvent(event);
    if (event.type === "stream.mark" && isCaughtUp(event.data)) {
      entry.options.onCaughtUp?.(event.cursor);
    }
  }
}

function isCaughtUp(data: unknown): boolean {
  return (
    typeof data === "object" && data !== null && (data as { caughtUp?: unknown }).caughtUp === true
  );
}
