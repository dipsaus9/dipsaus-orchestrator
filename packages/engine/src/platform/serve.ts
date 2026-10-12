// The daemon's listener on `<runtime>/dipo.sock` (0006 decision 9): `Bun.serve({ unix })` with a
// `fetch` handler that upgrades every request to a WebSocket and a `websocket` handler that hands
// each text frame to the connection's session. One text frame holds one JSON frame; what a frame
// means is the caller's business. Engine code reaches `Bun.serve` only through this module (0004
// amendment c).

import { removeSocketFile } from "./socket";

/** WebSocket close codes the daemon uses (RFC 6455 section 7.4.1). */
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_UNSUPPORTED_DATA = 1003;
export const CLOSE_INVALID_PAYLOAD = 1007;
export const CLOSE_POLICY_VIOLATION = 1008;

/**
 * A connection whose unsent data passes this many bytes is closed, so one slow client cannot make
 * the daemon buffer without bound. Delivery is at least once (0005 section 8): the client
 * reconnects and replays from its last cursor.
 */
export const BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024;
/** The largest frame a client may send. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** How long `stop` waits for clients to answer the close frame before cutting connections. */
export const CLOSE_GRACE_MS = 1000;

/** One accepted WebSocket connection, as the session sees it. */
export interface SocketConnection {
  /** Sends one text frame. */
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** What the daemon keeps per connection. */
export interface ConnectionSession {
  /** One text frame from the client. */
  message(text: string): void;
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
export function serveUnixSocket(path: string, accept: AcceptConnection): ServedSocket {
  const open = new Set<Bun.ServerWebSocket<SocketData>>();
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
      backpressureLimit: BACKPRESSURE_LIMIT_BYTES,
      closeOnBackpressureLimit: true,
      open(ws) {
        open.add(ws);
        ws.data.session = accept({
          send: (text) => {
            ws.send(text);
          },
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
    stop: async (options = {}) => {
      // Let frames sent in this tick leave first: a stop that follows a reply in the same tick
      // (`daemon.stop`) must not cut that reply off.
      await Bun.sleep(0);
      for (const ws of open) {
        ws.close(CLOSE_GOING_AWAY, options.reason ?? "the daemon is stopping");
      }
      const deadline = performance.now() + CLOSE_GRACE_MS;
      while (open.size > 0 && performance.now() < deadline) await Bun.sleep(10);
      await server.stop(true);
      if (options.removeFile !== false) removeSocketFile(path);
    },
  };
}
