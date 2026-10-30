// The daemon's Unix socket `<runtime>/dipo.sock` (0006 decisions 6 and 9). Binding is not a lock (a
// second bind on a live path fails with EADDRINUSE on Bun 1.4.2, and a leftover file must be
// unlinked first), so the daemon lock in `<state>` guards the socket. `serve.ts` serves the contract
// on it; this module removes leftovers and holds the daemon side's own small `ws+unix://` client,
// which the lock's step 3 uses to send `engine.hello` and `daemon.status` to the running daemon.

import { rmSync } from "node:fs";

import {
  type Clock,
  type ClientFrame,
  type CommandReply,
  type ReadReply,
  ServerFrame,
  type TimerHandle,
} from "@dipsaus-orchestrator/contract";

/** Removes a leftover socket file; a missing file is fine. */
export function removeSocketFile(path: string): void {
  rmSync(path, { force: true });
}

/** A frame that gets a reply: everything but `unsubscribe`. */
export type RequestFrame = Exclude<ClientFrame, { kind: "unsubscribe" }>;

export type SocketReply = CommandReply | ReadReply;

/** A minimal contract connection; replies are matched by `requestId`, events are ignored. */
export interface SocketClient {
  /** Sends `frame` and resolves with its reply, or null on timeout or a closed connection. */
  request(frame: RequestFrame): Promise<SocketReply | null>;
  close(): void;
}

export interface ConnectOptions {
  readonly clock: Clock;
  /** How long the connection and each request may take. */
  readonly timeoutMs: number;
}

/** Connects with `ws+unix://` to `path`; null when nothing accepts within the timeout. */
export function connectUnixSocket(
  path: string,
  options: ConnectOptions,
): Promise<SocketClient | null> {
  const { clock, timeoutMs } = options;
  const pending = new Map<string, (reply: SocketReply | null) => void>();
  let closed = false;
  const settleAll = () => {
    closed = true;
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  };

  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws+unix://${path}`);
  } catch {
    return Promise.resolve(null);
  }
  ws.addEventListener("message", (event) => {
    let frame: ServerFrame;
    try {
      const parsed = ServerFrame.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) return;
      frame = parsed.data;
    } catch {
      return;
    }
    if (frame.kind !== "reply") return;
    const resolve = pending.get(frame.reply.requestId);
    if (resolve === undefined) return;
    pending.delete(frame.reply.requestId);
    resolve(frame.reply);
  });
  ws.addEventListener("close", settleAll);

  const client: SocketClient = {
    request(frame) {
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        let timer: TimerHandle | null = null;
        const done = (reply: SocketReply | null) => {
          if (timer !== null) clock.clearTimeout(timer);
          resolve(reply);
        };
        pending.set(frame.requestId, done);
        timer = clock.setTimeout(() => {
          timer = null;
          pending.delete(frame.requestId);
          resolve(null);
        }, timeoutMs);
        try {
          ws.send(JSON.stringify(frame));
        } catch {
          pending.delete(frame.requestId);
          done(null);
        }
      });
    },
    close() {
      settleAll();
      ws.close();
    },
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: SocketClient | null) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      if (value === null) ws.close();
      resolve(value);
    };
    const timer = clock.setTimeout(() => finish(null), timeoutMs);
    ws.addEventListener("open", () => finish(client));
    ws.addEventListener("error", () => finish(null));
    ws.addEventListener("close", () => finish(null));
  });
}
