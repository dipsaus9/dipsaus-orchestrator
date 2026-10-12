// A transport the test drives by hand: every connection the client opens is kept, the test opens
// or closes it and hands it server frames, and every frame the client sends is recorded.

import type { ClientFrame, ServerFrame } from "@dipsaus-orchestrator/contract";

import type { Transport, TransportHandlers } from "../../src/index";

export class FakeConnection {
  readonly sent: ClientFrame[] = [];
  closedByClient = false;
  #ended = false;
  readonly #handlers: TransportHandlers;

  constructor(handlers: TransportHandlers) {
    this.#handlers = handlers;
  }

  get ended(): boolean {
    return this.#ended;
  }

  open(): void {
    this.#handlers.onOpen();
  }

  deliver(frame: ServerFrame | string): void {
    this.#handlers.onMessage(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** The daemon side ends the connection. */
  drop(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#handlers.onClose();
  }

  /** The last frame sent, which must exist. */
  last(): ClientFrame {
    const frame = this.sent.at(-1);
    if (frame === undefined) throw new Error("nothing was sent");
    return frame;
  }

  record(text: string): void {
    this.sent.push(JSON.parse(text) as ClientFrame);
  }

  endFromClient(): void {
    this.closedByClient = true;
    this.drop();
  }
}

export class FakeTransport implements Transport {
  readonly connections: FakeConnection[] = [];

  connect(handlers: TransportHandlers) {
    const connection = new FakeConnection(handlers);
    this.connections.push(connection);
    return {
      send: (text: string) => {
        if (!connection.ended) connection.record(text);
      },
      close: () => connection.endFromClient(),
    };
  }

  /** The newest connection, which must exist. */
  get current(): FakeConnection {
    const connection = this.connections.at(-1);
    if (connection === undefined) throw new Error("no connection was opened");
    return connection;
  }
}
