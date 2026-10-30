// The daemon's listener on `<runtime>/dipo.sock` (0006 decision 9): `Bun.serve({ unix })` with a
// `fetch` handler that upgrades every request to a WebSocket and a `websocket` handler that hands
// each text frame to the connection's session. One text frame holds one JSON frame; what a frame
// means is the caller's business. Engine code reaches `Bun.serve` only through this module (0004
// amendment c).

import { existsSync, linkSync, rmSync } from "node:fs";

import { removeSocketFile } from "./socket";

/**
 * Stops `server` and leaves the file at `path` as it was. Bun unlinks a unix socket's path when
 * its server stops, also when the path now names another daemon's socket (a daemon that lost its
 * lock): the file is linked aside first and linked back once the server stopped.
 */
async function stopKeepingFile(server: { stop(close: boolean): Promise<void> }, path: string) {
  const aside = `${path}.${process.pid}.keep`;
  let kept = false;
  try {
    rmSync(aside, { force: true });
    if (existsSync(path)) {
      linkSync(path, aside);
      kept = true;
    }
  } catch {
    // Nothing to keep: the stop goes on.
  }
  try {
    await server.stop(true);
  } finally {
    if (kept) {
      try {
        if (!existsSync(path)) linkSync(aside, path);
      } finally {
        rmSync(aside, { force: true });
      }
    }
  }
}

/** WebSocket close codes the daemon uses (RFC 6455 section 7.4.1). */
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_UNSUPPORTED_DATA = 1003;
export const CLOSE_INVALID_PAYLOAD = 1007;
export const CLOSE_POLICY_VIOLATION = 1008;

/**
 * A connection whose unsent data passes this many bytes is terminated, so one slow client cannot
 * make the daemon buffer without bound (the daemon's office catch-up already pauses far below it). Delivery is at least once (0005 section 8): the client
 * reconnects and replays from its last cursor.
 */
export const BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024;
/** The largest frame a client may send. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** How long `stop` waits for clients to answer the close frame before cutting connections. */
export const CLOSE_GRACE_MS = 1000;

export type SendResult = "sent" | "backpressure" | "dropped";

/** One accepted WebSocket connection, as the session sees it. */
export interface SocketConnection {
  /**
   * Sends one text frame. `backpressure`: it was queued behind unsent data (see `buffered`). `dropped`: the connection passed the backpressure limit and is closing,
   * or is closed; nothing more should be sent or prepared for it.
   */
  send(text: string): SendResult;
  /** Bytes sent but not yet written to the socket. */
  buffered(): number;
  close(code?: number, reason?: string): void;
}

/** What the daemon keeps per connection. */
export interface ConnectionSession {
  /** One text frame from the client. */
  message(text: string): void;
  /** Some queued data has been written; `buffered` is lower, bulk sending may continue. */
  drain(): void;
  /** The connection is gone, closed by either side. */
  closed(): void;
}

export type AcceptConnection = (connection: SocketConnection) => ConnectionSession;

export interface ServedSocket {
  readonly path: string;
  /** Open connections. */
  readonly connections: number;
  /**
   * Closes every connection with 1001 (going away) after the frames already sent, waits up to
   * `CLOSE_GRACE_MS` for the clients to close, stops listening and, unless `removeFile` is false,
   * removes the socket file.
   */
  stop(options?: { readonly removeFile?: boolean; readonly reason?: string }): Promise<void>;
}

interface SocketData {
  session: ConnectionSession | null;
}

/** Binds `path` and serves WebSocket connections on it; plain HTTP requests get 426. */
export interface ServeOptions {
  /** Replaces `BACKPRESSURE_LIMIT_BYTES`; tests use a small limit. */
  readonly backpressureLimitBytes?: number;
}

export function serveUnixSocket(
  path: string,
  accept: AcceptConnection,
  options: ServeOptions = {},
): ServedSocket {
  const open = new Set<Bun.ServerWebSocket<SocketData>>();
  const limit = options.backpressureLimitBytes ?? BACKPRESSURE_LIMIT_BYTES;
  const server = Bun.serve<SocketData>({
    unix: path,
    fetch(request, srv) {
      if (srv.upgrade(request, { data: { session: null } })) return undefined;
      return new Response("dipo.sock speaks the dipo contract over WebSocket only.\n", {
        status: 426,
        headers: { Upgrade: "websocket" },
      });
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      backpressureLimit: limit,
      closeOnBackpressureLimit: true,
      open(ws) {
        open.add(ws);
        ws.data.session = accept({
          // Bun returns -1 when the frame was queued under backpressure and 0 when it was dropped.
          // Bun 1.4.2 drops frames past `backpressureLimit` but leaves the connection open, so the
          // limit is enforced here: a connection past it is terminated, and the client
          // reconnects and replays from its cursor.
          send: (text) => {
            const result = ws.send(text);
            if (result === 0 || ws.getBufferedAmount() > limit) {
              ws.terminate();
              return "dropped";
            }
            return result > 0 ? "sent" : "backpressure";
          },
          buffered: () => ws.getBufferedAmount(),
          close: (code, reason) => ws.close(code, reason),
        });
      },
      message(ws, message) {
        if (typeof message !== "string") {
          ws.close(CLOSE_UNSUPPORTED_DATA, "dipo frames are JSON text frames");
          return;
        }
        ws.data.session?.message(message);
      },
      drain(ws) {
        ws.data.session?.drain();
      },
      close(ws) {
        open.delete(ws);
        const session = ws.data.session;
        ws.data.session = null;
        session?.closed();
      },
    },
  });
  return {
    path,
    get connections() {
      return open.size;
    },
    stop: async (stopOptions = {}) => {
      // Let frames sent in this tick leave first: a stop that follows a reply in the same tick
      // (`daemon.stop`) must not cut that reply off.
      await Bun.sleep(0);
      for (const ws of open) {
        ws.close(CLOSE_GOING_AWAY, stopOptions.reason ?? "the daemon is stopping");
      }
      const deadline = performance.now() + CLOSE_GRACE_MS;
      while (open.size > 0 && performance.now() < deadline) await Bun.sleep(10);
      if (stopOptions.removeFile === false) {
        await stopKeepingFile(server, path);
        return;
      }
      await server.stop(true);
      removeSocketFile(path);
    },
  };
}
