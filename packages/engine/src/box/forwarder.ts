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

import { createServer, type Server, type Socket } from "node:net";

import { connectToBox } from "./box-connect";

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
  options?: ForwarderOptions,
) => Promise<RunningForwarder>;

export interface ForwarderOptions {
  /** The port to listen on when it is free (a daemon restart keeps an open test's URL). */
  readonly port?: number;
  /**
   * Ports the forwarder never takes: the office's `box.localPorts`, which boxes reach on the Mac's
   * loopback through the web route (DIPO-282), so no box reaches a forwarder there.
   */
  readonly avoid?: readonly number[];
}

/** How many free ports the forwarder tries before it gives up on one outside `avoid`. */
const FORWARDER_PORT_TRIES = 20;

/**
 * A connection to the box through dipo's one way into the box network (`connectToBox`, DIPO-343):
 * from the Mac's address on the box bridge, so it works while a VPN routes the box network's range.
 * `timeoutMs` is its idle deadline. Throws `box.refused` when the source is no address of the box's
 * family.
 */
function toBox(target: ForwardTarget, timeoutMs: number): Socket {
  const socket = connectToBox({
    address: target.address,
    port: target.port,
    hostAddress: target.source,
  });
  socket.setTimeout(timeoutMs);
  return socket;
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
    let upstream: Socket;
    try {
      upstream = toBox(target, FORWARDER_CONNECT_TIMEOUT_MS);
    } catch {
      open.delete(client);
      client.destroy();
      return;
    }
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
  const avoid = new Set(options.avoid ?? []);
  const wanted = options.port !== undefined && !avoid.has(options.port) ? options.port : 0;
  try {
    await listen(server, wanted);
  } catch (error) {
    if (wanted === 0) throw error;
    await listen(server, 0);
  }
  const portOf = (): number | null => {
    const address = server.address();
    return address === null || typeof address === "string" ? null : address.port;
  };
  for (let tries = 0; avoid.has(portOf() ?? 0) && tries < FORWARDER_PORT_TRIES; tries++) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await listen(server, 0);
  }
  const port = portOf();
  if (port === null || avoid.has(port)) {
    server.close();
    throw new Error("the test forwarder found no free port outside the office's local ports");
  }
  return {
    port,
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
    let socket: Socket;
    try {
      socket = toBox(target, timeoutMs);
    } catch {
      resolve(false);
      return;
    }
    const done = (reached: boolean): void => {
      socket.destroy();
      resolve(reached);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
