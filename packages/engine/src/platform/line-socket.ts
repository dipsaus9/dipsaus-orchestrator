// Newline-delimited text frames over a Unix stream socket (`Bun.listen` and `Bun.connect`). The
// worker host's steering socket `<runtime>/hosts/<run-id>.sock` speaks its small protocol over it
// (0006 decision 8): separate from the client contract, so it needs no WebSocket. Access control
// is the `0700` runtime directory, as for `dipo.sock` (0006 decision 11). Engine code reaches
// these Bun APIs only through this module (0004 amendment c).

import { removeSocketFile } from "./socket";

/** The largest frame either side accepts; a longer line closes the connection. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** How long `stop` waits for queued frames to leave before it cuts a connection. */
export const LINE_FLUSH_GRACE_MS = 1000;

/** One open connection, as either side sees it. */
export interface LineConnection {
  /** Queues one frame; a newline is added. False when the connection is closed. */
  send(line: string): boolean;
  /** Closes after the queued frames have been written. */
  close(): void;
}

/** What a server keeps per accepted connection. */
export interface LineSession {
  line(text: string): void;
  closed(): void;
}

export interface LineServer {
  readonly path: string;
  readonly connections: number;
  /** Flushes and closes every connection, stops listening and removes the socket file. */
  stop(): Promise<void>;
}

interface Pipe {
  queue: Uint8Array[];
  closing: boolean;
  closed: boolean;
}

const encoder = new TextEncoder();

/** Writes as much of the queue as the socket takes; ends the socket once a close is drained. */
function flush(socket: Bun.Socket<unknown>, pipe: Pipe): void {
  while (pipe.queue.length > 0) {
    const head = pipe.queue[0] as Uint8Array;
    const written = socket.write(head);
    if (written <= 0) return;
    if (written < head.byteLength) {
      pipe.queue[0] = head.subarray(written);
      return;
    }
    pipe.queue.shift();
  }
  if (pipe.closing && !pipe.closed) {
    pipe.closed = true;
    socket.end();
  }
}

function connectionOf(socket: Bun.Socket<unknown>, pipe: Pipe): LineConnection {
  return {
    send(line) {
      if (pipe.closing || pipe.closed) return false;
      pipe.queue.push(encoder.encode(`${line}\n`));
      flush(socket, pipe);
      return true;
    },
    close() {
      if (pipe.closing) return;
      pipe.closing = true;
      flush(socket, pipe);
    },
  };
}

/** Splits incoming bytes into lines; returns null once a line passes `MAX_LINE_BYTES`. */
class LineReader {
  readonly #decoder = new TextDecoder();
  #buffer = "";

  push(chunk: Uint8Array): string[] | null {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    const parts = this.#buffer.split("\n");
    this.#buffer = parts.pop() ?? "";
    if (this.#buffer.length > MAX_LINE_BYTES) return null;
    return parts;
  }
}

interface ServerData {
  pipe: Pipe;
  reader: LineReader;
  session: LineSession | null;
}

/** Binds `path` (a leftover file must be removed first) and serves line connections. */
export function listenLineSocket(
  path: string,
  accept: (connection: LineConnection) => LineSession,
): LineServer {
  const open = new Set<Bun.Socket<ServerData>>();
  const listener = Bun.listen<ServerData>({
    unix: path,
    socket: {
      open(socket) {
        const pipe: Pipe = { queue: [], closing: false, closed: false };
        socket.data = { pipe, reader: new LineReader(), session: null };
        open.add(socket);
        socket.data.session = accept(connectionOf(socket as Bun.Socket<unknown>, pipe));
      },
      data(socket, chunk) {
        const lines = socket.data.reader.push(chunk);
        if (lines === null) {
          socket.data.pipe.closed = true;
          socket.end();
          return;
        }
        for (const line of lines) {
          if (socket.data.pipe.closed) return;
          socket.data.session?.line(line);
        }
      },
      drain(socket) {
        flush(socket as Bun.Socket<unknown>, socket.data.pipe);
      },
      close(socket) {
        open.delete(socket);
        socket.data.pipe.closed = true;
        const session = socket.data.session;
        socket.data.session = null;
        session?.closed();
      },
      end(socket) {
        socket.end();
      },
      error(socket) {
        socket.end();
      },
    },
  });
  return {
    path,
    get connections() {
      return open.size;
    },
    stop: async () => {
      for (const socket of open) {
        const pipe = socket.data.pipe;
        if (!pipe.closing) {
          pipe.closing = true;
          flush(socket as Bun.Socket<unknown>, pipe);
        }
      }
      const deadline = performance.now() + LINE_FLUSH_GRACE_MS;
      while (open.size > 0 && performance.now() < deadline) await Bun.sleep(5);
      for (const socket of open) socket.terminate();
      listener.stop(true);
      removeSocketFile(path);
    },
  };
}

export interface LineHandlers {
  line(text: string): void;
  closed(): void;
}

interface ClientData {
  pipe: Pipe;
  reader: LineReader;
  handlers: LineHandlers;
  ended: boolean;
}

/** Connects to `path`; null when nothing accepts there. */
export async function connectLineSocket(
  path: string,
  handlers: LineHandlers,
): Promise<LineConnection | null> {
  const pipe: Pipe = { queue: [], closing: false, closed: false };
  const data: ClientData = { pipe, reader: new LineReader(), handlers, ended: false };
  const end = () => {
    pipe.closed = true;
    if (data.ended) return;
    data.ended = true;
    handlers.closed();
  };
  let socket: Bun.Socket<ClientData>;
  try {
    socket = await Bun.connect<ClientData>({
      unix: path,
      data,
      socket: {
        data(sock, chunk) {
          const lines = sock.data.reader.push(chunk);
          if (lines === null) {
            sock.end();
            end();
            return;
          }
          for (const line of lines) {
            if (sock.data.ended) return;
            sock.data.handlers.line(line);
          }
        },
        drain(sock) {
          flush(sock as Bun.Socket<unknown>, sock.data.pipe);
        },
        close: end,
        end: (sock) => {
          sock.end();
          end();
        },
        error: (sock) => {
          sock.end();
          end();
        },
        connectError: end,
      },
    });
  } catch {
    return null;
  }
  return connectionOf(socket as Bun.Socket<unknown>, pipe);
}
