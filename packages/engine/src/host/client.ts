// The engine side of the host socket: connect, handshake with the run id and the versions this
// binary speaks, then send ops and receive `advanced` while watching. A host that does not answer
// is not dead: liveness is PID plus start time (0006 decision 8), and a silent socket only means
// follow-only mode (DIPO-57).

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import { connectLineSocket, type LineConnection } from "../platform/line-socket";
import {
  HOST_PROTOCOL_VERSIONS,
  HostFrameSchema,
  type HostError,
  type HostStatus,
} from "./protocol";
import type { HostSignal as HostSignalName } from "../workers/types";

export type HostRequest =
  | { readonly op: "write"; readonly data: string }
  | { readonly op: "signal"; readonly signal: HostSignalName; readonly afterMs?: number }
  | { readonly op: "closeStdin" }
  | { readonly op: "status" }
  | { readonly op: "watch" };

export type HostReply =
  | { readonly ok: true; readonly result?: unknown }
  | { readonly ok: false; readonly error: HostError };

export interface HostClient {
  /** The protocol version the host picked. */
  readonly version: number;
  readonly hostPid: number;
  /**
   * Sends one op; null when the connection closed or the reply did not come in time. `timeoutMs`
   * replaces the connection's timeout for this op.
   */
  request(request: HostRequest, timeoutMs?: number): Promise<HostReply | null>;
  status(): Promise<HostStatus | null>;
  /** Starts watching; `listener` gets each `advanced` offset. Resolves to the current offset. */
  watch(listener: (offset: number) => void): Promise<number | null>;
  /** Settles when the host closes the connection. */
  readonly closed: Promise<void>;
  close(): void;
}

export type ConnectHostResult =
  | { readonly ok: true; readonly client: HostClient }
  | {
      readonly ok: false;
      readonly reason: "unreachable" | "timeout" | "refused";
      readonly error?: HostError;
    };

export interface ConnectHostOptions {
  readonly runId: string;
  readonly clock: Clock;
  readonly timeoutMs: number;
  /** Versions offered in the handshake; this binary's by default. */
  readonly versions?: readonly number[];
}

type Failure = Extract<ConnectHostResult, { ok: false }>;
type Handshake = { readonly ok: true; readonly version: number; readonly pid: number } | Failure;

/** Resolves with `start`'s value, or with `onTimeout` once `timeoutMs` passed on `clock`. */
function withTimeout<T>(
  clock: Clock,
  timeoutMs: number,
  start: (settle: (value: T) => void) => void,
  onTimeout: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let timer: TimerHandle | null = null;
    let settled = false;
    const settle = (value: T) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      resolve(value);
    };
    timer = clock.setTimeout(() => settle(onTimeout), timeoutMs);
    start(settle);
  });
}

export async function connectHost(
  socketPath: string,
  options: ConnectHostOptions,
): Promise<ConnectHostResult> {
  const { clock, timeoutMs } = options;
  const pending = new Map<number, (reply: HostReply | null) => void>();
  const watchers: ((offset: number) => void)[] = [];
  let handshake: ((result: Handshake) => void) | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let nextId = 1;
  let isClosed = false;

  const connection: LineConnection | null = await connectLineSocket(socketPath, {
    line: (text) => {
      let parsed;
      try {
        parsed = HostFrameSchema.safeParse(JSON.parse(text));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const frame = parsed.data;
      switch (frame.kind) {
        case "hello":
          handshake?.({ ok: true, version: frame.version, pid: frame.pid });
          handshake = null;
          return;
        case "refused":
          handshake?.({ ok: false, reason: "refused", error: frame.error as HostError });
          handshake = null;
          return;
        case "reply": {
          const resolve = pending.get(frame.id);
          if (resolve === undefined) return;
          pending.delete(frame.id);
          resolve(
            frame.ok
              ? { ok: true, result: frame.result }
              : {
                  ok: false,
                  error: (frame.error ?? { code: "frame.invalid", message: "" }) as HostError,
                },
          );
          return;
        }
        case "advanced":
          for (const watcher of watchers) watcher(frame.offset);
          return;
      }
    },
    closed: () => {
      isClosed = true;
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
      handshake?.({ ok: false, reason: "unreachable" });
      handshake = null;
      resolveClosed();
    },
  });
  if (connection === null) return { ok: false, reason: "unreachable" };

  const hello = await withTimeout<Handshake>(
    clock,
    timeoutMs,
    (settle) => {
      handshake = settle;
      connection.send(
        JSON.stringify({
          kind: "hello",
          versions: options.versions ?? HOST_PROTOCOL_VERSIONS,
          run: options.runId,
        }),
      );
    },
    { ok: false, reason: "timeout" },
  );
  if (!hello.ok) {
    connection.close();
    return hello;
  }

  const request = (body: HostRequest, timeout: number = timeoutMs) =>
    withTimeout<HostReply | null>(
      clock,
      timeout,
      (settle) => {
        if (isClosed) {
          settle(null);
          return;
        }
        const id = nextId++;
        pending.set(id, settle);
        if (!connection.send(JSON.stringify({ kind: "op", id, ...body }))) {
          pending.delete(id);
          settle(null);
        }
      },
      null,
    );
  const client: HostClient = {
    version: hello.version,
    hostPid: hello.pid,
    request,
    status: async () => {
      const reply = await request({ op: "status" });
      return reply?.ok === true ? (reply.result as HostStatus) : null;
    },
    watch: async (listener) => {
      watchers.push(listener);
      const reply = await request({ op: "watch" });
      return reply?.ok === true ? (reply.result as { offset: number }).offset : null;
    },
    closed,
    close: () => connection.close(),
  };
  return { ok: true, client };
}
