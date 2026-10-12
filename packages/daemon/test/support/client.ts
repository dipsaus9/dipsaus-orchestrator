// A `ws+unix://` test client for the contract on `dipo.sock`. Every frame the server sends is
// checked against `ServerFrame`; a frame that does not parse is kept in `invalid`, and each test
// asserts that list is empty (DIPO-24 test plan).

import {
  CONTRACT_VERSION,
  type CommandReply,
  type ContractVersion,
  type Cursor,
  type Event,
  type ReadReply,
  ServerFrame,
} from "@dipsaus-orchestrator/contract";

type Reply = CommandReply | ReadReply;

const WAIT_MS = 5000;

let counter = 0;
/** A fresh request id: a valid ULID made of digits. */
export function requestId(): string {
  counter += 1;
  return `0${String(counter).padStart(25, "0")}`;
}

export class TestClient {
  readonly frames: ServerFrame[] = [];
  readonly invalid: unknown[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    this.closed = new Promise((resolve) =>
      ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })),
    );
    ws.addEventListener("message", (event) => {
      const raw: unknown = JSON.parse(String(event.data));
      const parsed = ServerFrame.safeParse(raw);
      if (parsed.success) this.frames.push(parsed.data);
      else this.invalid.push(raw);
    });
  }

  static connect(socketPath: string): Promise<TestClient> {
    const ws = new WebSocket(`ws+unix://${socketPath}`);
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new TestClient(ws)));
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${socketPath}`)));
    });
  }

  /** Sends any JSON value as one text frame. */
  sendRaw(value: unknown): void {
    this.#ws.send(typeof value === "string" ? value : JSON.stringify(value));
  }

  /** Sends a frame that carries `requestId` and waits for its reply. */
  async request(frame: Record<string, unknown>): Promise<Reply> {
    const id = (frame["requestId"] as string | undefined) ?? requestId();
    this.sendRaw({ ...frame, requestId: id });
    const reply = await this.waitFor(
      (f) => f.kind === "reply" && f.reply.requestId === id,
      `reply to ${id}`,
    );
    if (reply.kind !== "reply") throw new Error("unreachable");
    return reply.reply;
  }

  read(name: string, args: unknown = {}): Promise<Reply> {
    return this.request({ kind: "read", name, args });
  }

  command(name: string, args: unknown, extra: Record<string, unknown> = {}): Promise<Reply> {
    return this.request({ kind: "command", name, args, origin: "other", ...extra });
  }

  hello(contract: ContractVersion = CONTRACT_VERSION): Promise<Reply> {
    return this.read("engine.hello", { contract, client: { name: "test", version: "0" } });
  }

  subscribe(stream: string, after?: Cursor, filter?: string[]): Promise<Reply> {
    return this.request({
      kind: "subscribe",
      stream,
      ...(after === undefined ? {} : { after }),
      ...(filter === undefined ? {} : { filter }),
    });
  }

  /** Every event received so far on `stream`, in order. */
  events(stream: string): Event[] {
    return this.frames
      .flatMap((frame) => (frame.kind === "events" ? frame.events : []))
      .filter((event) => event.cursor.stream === stream);
  }

  /** Waits until a frame received so far, or later, matches. */
  async waitFor(match: (frame: ServerFrame) => boolean, what: string): Promise<ServerFrame> {
    const deadline = performance.now() + WAIT_MS;
    for (;;) {
      const found = this.frames.find(match);
      if (found !== undefined) return found;
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(5);
    }
  }

  /** Waits until `stream` has an event matching. */
  async waitForEvent(stream: string, match: (event: Event) => boolean, what: string) {
    await this.waitFor(
      (frame) =>
        frame.kind === "events" &&
        frame.events.some((event) => event.cursor.stream === stream && match(event)),
      what,
    );
    const event = this.events(stream).find(match);
    if (event === undefined) throw new Error("unreachable");
    return event;
  }

  close(): Promise<{ code: number; reason: string }> {
    this.#ws.close();
    return this.closed;
  }
}

/** Gives the event loop a few turns, so frames in flight arrive. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Bun.sleep(2);
}
