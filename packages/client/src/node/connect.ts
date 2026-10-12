// Connecting to a running daemon: the socket named in `<state>/runtime.json`, then `engine.hello`.

import type { Clock, Origin } from "@dipsaus-orchestrator/contract";

import { ClientError, DipoClient } from "../client";
import { systemClock } from "./clock";
import { type Env, readRuntimeInfo, type RuntimeInfo, stateDir } from "./runtime";
import { unixSocketTransport } from "./transport";

/** No daemon answers: `runtime.json` is missing or its socket does not take a connection. */
export class DaemonNotRunningError extends Error {
  readonly state: string;

  constructor(state: string, detail: string) {
    super(`no daemon is running (${detail})`);
    this.name = "DaemonNotRunningError";
    this.state = state;
  }
}

export interface ConnectToDaemonOptions {
  readonly client: { readonly name: string; readonly version: string };
  readonly origin: Origin;
  readonly env?: Env;
  readonly clock?: Clock;
  /** How long the first connection may take to answer `engine.hello`. */
  readonly timeoutMs?: number;
}

/**
 * Connects to the daemon named in `<state>/runtime.json` and completes `engine.hello`. Throws
 * `DaemonNotRunningError` when there is no record or nothing answers on its socket, and a
 * `ClientError` when `engine.hello` fails (for example `contract.unsupported`).
 */
export async function connectToDaemon(
  options: ConnectToDaemonOptions,
): Promise<{ client: DipoClient; runtime: RuntimeInfo }> {
  const state = stateDir(options.env);
  const runtime = readRuntimeInfo(state);
  if (runtime === null) throw new DaemonNotRunningError(state, `no runtime.json in ${state}`);
  const client = new DipoClient({
    transport: unixSocketTransport(runtime.socket),
    clock: options.clock ?? systemClock,
    client: options.client,
    origin: options.origin,
  });
  try {
    await client.connect(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
  } catch (error) {
    if (error instanceof ClientError && error.code === "client.unreachable") {
      throw new DaemonNotRunningError(state, `nothing answers on ${runtime.socket}`);
    }
    throw error;
  }
  return { client, runtime };
}
