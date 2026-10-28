// The test URL's forwarder on the Mac (DIPO-309, 0002, 0008): how the maintainer's browser reaches
// the product a test box runs, with no port published.
//
// It listens on the Mac's loopback (127.0.0.1) only, on a free port, so nothing beyond the Mac
// reaches it, and passes each connection to the `dev` port at the test box's address. Its own
// connection to the box starts from the Mac's address on the box network: bound to that address,
// macOS sends it out through the box bridge even while a VPN routes the box network's range
// through its tunnel (the first step of DIPO-309 found the Mac reaches a box only so), and the test
// box's firewall answers only connections from that address to its `dev` port (`firewall.ts`).
//
// Bytes pass through unread. The forwarder holds at most `FORWARDER_MAX_CONNECTIONS` at once and
// closes both sides of a connection when either side ends or fails. `close` stops it and ends every
// connection it holds.

import { connect, createServer, type Server, type Socket } from "node:net";

/** The only address the forwarder listens on. */
export const FORWARDER_HOST = "127.0.0.1";

/** The most connections the forwarder holds at once; a further one is closed at once. */
export const FORWARDER_MAX_CONNECTIONS = 256;

/** How long the forwarder's connect to the box may take before the client's connection closes. */
export const FORWARDER_CONNECT_TIMEOUT_MS = 10_000;

/** What a forwarder passes connections to. */
export interface ForwardTarget {
  /** The test box's address on the box network. */
  readonly address: string;
  /** The `dev` port there. */
  readonly port: number;
  /** The Mac's address on the box network, which the connection to the box starts from. */
  readonly source: string;
}

/** A running forwarder. */
export interface RunningForwarder {
  /** Its port on the Mac's loopback. */
  readonly port: number;
  /** The connections it holds now. */
  readonly connections: () => number;
  close(): Promise<void>;
}

/** Starts a forwarder; see `startForwarder`. */
export type StartForwarder = (
  target: ForwardTarget,
  options?: { readonly port?: number },
) => Promise<RunningForwarder>;

/**
 * The one way dipo's Mac side opens a connection to a box (DIPO-309): from the Mac's address on
 * the box network (`localAddress`), so macOS sends it through the box bridge even while a VPN routes
 * the box network's range through its tunnel. `timeoutMs` is the connect's idle deadline.
 */
export function connectToBox(target: ForwardTarget, timeoutMs: number): Socket {
  return connect({
    host: target.address,
    port: target.port,
    localAddress: target.source,
    timeout: timeoutMs,
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => {
      server.off("listening", done);
      reject(error);
    };
    const done = (): void => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", done);
    server.listen({ host: FORWARDER_HOST, port, exclusive: true });
  });
}

/**
 * Starts the forwarder to `target` on the Mac's loopback: on `options.port` when it is free (a
 * daemon restart keeps an open test's URL), else on a free port. Rejects when it cannot listen.
 */
export const startForwarder: StartForwarder = async (target, options = {}) => {
  const open = new Set<Socket>();
  const server = createServer({ pauseOnConnect: true }, (client) => {
    if (open.size >= FORWARDER_MAX_CONNECTIONS) {
      client.destroy();
      return;
    }
    open.add(client);
    const upstream = connectToBox(target, FORWARDER_CONNECT_TIMEOUT_MS);
    open.add(upstream);
    // A failure ends both sides at once; a side that closes ends the other only after what it
    // sent was written (a `dev` that answers and closes at once loses nothing).
    const end = (): void => {
      client.destroy();
      upstream.destroy();
      open.delete(client);
      open.delete(upstream);
    };
    const closed = (socket: Socket, other: Socket): void => {
      open.delete(socket);
      if (!other.destroyed) other.end();
    };
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.once("timeout", end);
    client.once("close", () => closed(client, upstream));
    upstream.once("close", () => closed(upstream, client));
    for (const socket of [client, upstream]) {
      socket.once("error", end);
    }
  });
  const wanted = options.port ?? 0;
  try {
    await listen(server, wanted);
  } catch (error) {
    if (wanted === 0) throw error;
    await listen(server, 0);
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the test forwarder has no port");
  }
  return {
    port: address.port,
    connections: () => open.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        open.clear();
        server.close(() => resolve());
      }),
  };
};

/**
 * True when a TCP connection from `target.source` reaches `target.address:target.port` within
 * `timeoutMs` (DIPO-309): whether `dev` answers at the test box's address, through the box bridge.
 * The connection is closed at once.
 */
export function systemReach(target: ForwardTarget, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectToBox(target, timeoutMs);
    const done = (reached: boolean): void => {
      socket.destroy();
      resolve(reached);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
