// A daemon in memory for tests that run real `DipoClient`s against it (DIPO-322): it answers
// `engine.hello`, `office.snapshot`, `office.switch` and one test-defined command, serves the
// software stream and one office stream with replay after a cursor and `stream.mark { caughtUp }`,
// and broadcasts each new office entry to every subscriber, whichever client wrote it. A restart
// drops every connection, starts the software stream again at a higher seq (the real one starts at
// the daemon's start time) and comes back in `recovering`, where office reads and office
// subscriptions are refused with `engine.recovering`, as the real lifecycle gate does; the office
// log survives, as the state database does. Frames go out in
// microtasks, so a client never sees a reply inside its own `send`.

import {
  CONTRACT_VERSION,
  type Cursor,
  type DaemonState,
  type EngineError,
  type Event,
  Event as EventSchema,
  findEvent,
  type OfficeId,
  OfficeSnapshot,
  OfficeSummary,
  type RequestId,
  type ServerFrame,
  type StoryView,
  StreamName,
  type WorkView,
} from "@dipsaus-orchestrator/contract";

import type { Transport, TransportConnection, TransportHandlers } from "../../src/index";

const AT = "2026-10-23T10:00:00.000Z";

interface Connection {
  readonly handlers: TransportHandlers;
  /** Subscribed streams and the position each was brought to. */
  readonly streams: Map<string, Cursor>;
  open: boolean;
}

interface Frame {
  readonly kind: string;
  readonly requestId?: string;
  readonly name?: string;
  readonly args?: { office?: string };
  readonly office?: string;
  readonly stream?: string;
  readonly after?: Cursor;
}

/** The facts a command wrote: event types and data, stored in the office log in this order. */
export type Write = readonly { readonly type: string; readonly data: unknown }[];

export class FakeDaemon implements Transport {
  readonly office: OfficeId;
  state: DaemonState = "running";
  /** False while the daemon is down: a connect attempt fails. */
  up = true;
  stories: StoryView[];
  work: WorkView[];
  /** What a command writes and answers; nothing by default. */
  onCommand: (name: string, args: unknown) => { write: Write; result: unknown } = () => ({
    write: [],
    result: {},
  });
  readonly #officeStream: StreamName;
  readonly #officeLog: Event[] = [];
  /** The software stream's seq before its first entry, higher at every start. */
  #softwareStart = 1_000_000;
  #softwareLog: Event[] = [];
  readonly #connections = new Set<Connection>();
  /** Every subscribe frame and its answer, for assertions. */
  readonly subscribes: { readonly stream: string; readonly after?: Cursor; answer: string }[] = [];

  constructor(office: OfficeId, stories: StoryView[], work: WorkView[] = []) {
    this.office = office;
    this.stories = stories;
    this.work = work;
    this.#officeStream = StreamName.parse(`office:${office}`);
  }

  get connections(): number {
    return [...this.#connections].filter((connection) => connection.open).length;
  }

  get officeHead(): Cursor {
    return { stream: this.#officeStream, seq: this.#officeLog.length };
  }

  get softwareHead(): Cursor {
    return {
      stream: StreamName.parse("software"),
      seq: this.#softwareStart + this.#softwareLog.length,
    };
  }

  connect(handlers: TransportHandlers): TransportConnection {
    const connection: Connection = { handlers, streams: new Map(), open: this.up };
    if (!this.up) {
      queueMicrotask(() => handlers.onClose());
      return { send: () => {}, close: () => {} };
    }
    this.#connections.add(connection);
    queueMicrotask(() => {
      if (connection.open) handlers.onOpen();
    });
    return {
      send: (text) => {
        if (connection.open) this.#frame(connection, JSON.parse(text) as Frame);
      },
      close: () => {
        connection.open = false;
        this.#connections.delete(connection);
      },
    };
  }

  /** Stops the daemon: every connection is dropped and connects fail until `start`. */
  stop(): void {
    this.up = false;
    for (const connection of this.#connections) {
      connection.open = false;
      queueMicrotask(() => connection.handlers.onClose());
    }
    this.#connections.clear();
  }

  /** Starts it again in `recovering` with a new software stream; the office log is kept. */
  start(): void {
    this.up = true;
    this.state = "recovering";
    this.#softwareStart += 1_000_000;
    this.#softwareLog = [];
  }

  /** The daemon's state changes: a stored `daemon.state` event on the software stream. */
  setState(to: DaemonState): void {
    const from = this.state;
    this.state = to;
    this.#appendSoftware("daemon.state", { from, to });
  }

  /** Stores `write` in the office log, applies its views and sends it to every subscriber. */
  write(write: Write): Cursor {
    for (const { type, data } of write) {
      const definition = findEvent(type);
      if (definition === undefined) throw new Error(`unknown event ${type}`);
      const parsed = definition.data.parse(data) as { view?: unknown };
      const event = EventSchema.parse({
        cursor: { ...this.officeHead, seq: this.#officeLog.length + 1 },
        at: AT,
        type,
        data: parsed,
      });
      this.#officeLog.push(event);
      if (type === "story.state") this.#putStory(parsed.view as StoryView);
      else if (parsed.view !== undefined) this.#putWork(parsed.view as WorkView);
    }
    for (const connection of this.#connections) this.#pumpOffice(connection);
    return this.officeHead;
  }

  #putStory(view: StoryView): void {
    this.stories = [...this.stories.filter((story) => story.key !== view.key), view];
    this.work = this.work.filter(
      (work) => work.work.key !== view.key || work.work.run === view.work?.run,
    );
  }

  #putWork(view: WorkView): void {
    this.work = [...this.work.filter((work) => work.work.run !== view.work.run), view];
  }

  #appendSoftware(type: string, data: unknown): void {
    const event = EventSchema.parse({
      cursor: { ...this.softwareHead, seq: this.softwareHead.seq + 1 },
      at: AT,
      type,
      data,
    });
    this.#softwareLog.push(event);
    for (const connection of this.#connections) {
      if (connection.streams.has("software")) {
        connection.streams.set("software", event.cursor);
        this.#send(connection, { kind: "events", events: [event] });
      }
    }
  }

  #recovering(): boolean {
    return this.state === "starting" || this.state === "recovering";
  }

  #frame(connection: Connection, frame: Frame): void {
    const requestId = (frame.requestId ?? "") as RequestId;
    const reply = (result: unknown, extra: Record<string, unknown> = {}) =>
      this.#send(connection, {
        kind: "reply",
        reply: { ok: true, requestId, result, ...extra },
      } as ServerFrame);
    const refuse = (error: EngineError) =>
      this.#send(connection, { kind: "reply", reply: { ok: false, requestId, error } });
    if (frame.kind === "unsubscribe") {
      connection.streams.delete(frame.stream ?? "");
      return;
    }
    if (frame.kind === "subscribe") {
      this.#subscribe(connection, frame, reply, refuse);
      return;
    }
    if (frame.kind === "read" && frame.name === "engine.hello") {
      reply({
        engine: "0.1.0",
        contract: CONTRACT_VERSION,
        capabilities: [],
        daemon: this.state,
        offices: [this.#summary()],
        cursor: this.softwareHead,
      });
      return;
    }
    if (this.#recovering()) {
      refuse(recovering());
      return;
    }
    if (
      frame.kind === "read" &&
      (frame.name === "office.snapshot" || frame.name === "office.switch")
    ) {
      if (frame.args?.office !== this.office) {
        refuse({ code: "office.unknown", message: "no such office", retryable: false });
        return;
      }
      reply(
        OfficeSnapshot.parse({
          cursor: this.officeHead,
          stories: this.stories,
          work: this.work,
          gates: [],
          questions: [],
          tests: [],
        }),
      );
      return;
    }
    if (frame.kind === "command") {
      const { write, result } = this.onCommand(frame.name ?? "", frame.args);
      const cursor = this.write(write);
      reply(result, { changed: true, cursor });
      return;
    }
    refuse({ code: "contract.unknownName", message: `no ${frame.name}`, retryable: false });
  }

  #subscribe(
    connection: Connection,
    frame: Frame,
    reply: (result: unknown) => void,
    refuse: (error: EngineError) => void,
  ): void {
    const stream = frame.stream ?? "";
    const record = (answer: string) =>
      this.subscribes.push({
        stream,
        ...(frame.after === undefined ? {} : { after: frame.after }),
        answer,
      });
    connection.streams.delete(stream);
    if (stream === "software") {
      const head = this.softwareHead;
      const after = frame.after ?? head;
      if (after.seq < this.#softwareStart || after.seq > head.seq) {
        record("stream.resetRequired");
        refuse({
          code: "stream.resetRequired",
          message: "the software stream restarted",
          retryable: false,
          details: { oldest: { ...head, seq: this.#softwareStart } },
        });
        return;
      }
      record("ok");
      reply({ stream, from: after });
      const events = this.#softwareLog.filter((event) => event.cursor.seq > after.seq);
      connection.streams.set(stream, head);
      if (events.length > 0) this.#send(connection, { kind: "events", events });
      this.#send(connection, { kind: "events", events: [mark(head)] });
      return;
    }
    if (this.#recovering()) {
      record("engine.recovering");
      refuse(recovering());
      return;
    }
    const after = frame.after ?? this.officeHead;
    record("ok");
    reply({ stream, from: after });
    connection.streams.set(stream, after);
    this.#pumpOffice(connection);
    this.#send(connection, { kind: "events", events: [mark(connection.streams.get(stream)!)] });
  }

  /** Sends the office entries after the connection's position, as the daemon's pump does. */
  #pumpOffice(connection: Connection): void {
    const position = connection.streams.get(this.#officeStream);
    if (position === undefined) return;
    const events = this.#officeLog.filter((event) => event.cursor.seq > position.seq);
    if (events.length === 0) return;
    connection.streams.set(this.#officeStream, events.at(-1)!.cursor);
    this.#send(connection, { kind: "events", events });
  }

  #send(connection: Connection, frame: ServerFrame): void {
    const text = JSON.stringify(frame);
    queueMicrotask(() => {
      if (connection.open) connection.handlers.onMessage(text);
    });
  }

  #summary(): OfficeSummary {
    return OfficeSummary.parse({
      office: this.office,
      name: "alpha",
      path: "/work/alpha",
      running: this.work.length,
      parked: 0,
      waitingOnMaintainer: 0,
    });
  }
}

function recovering(): EngineError {
  return {
    code: "engine.recovering",
    message: "The daemon is starting and recovering its offices; try again shortly.",
    retryable: true,
    details: { state: "recovering" },
  };
}

function mark(cursor: Cursor): Event {
  return { cursor, at: AT, type: "stream.mark", data: { caughtUp: true } };
}
