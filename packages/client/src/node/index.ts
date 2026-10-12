// `@dipsaus-orchestrator/client/node`: the Unix-socket transport and the way a local client finds
// the daemon, the only client code that uses Bun and Node APIs (0004 and 0006 amendments of
// 2026-10-12). The `lifecycle` module (start, stop, PID checks, autostart) joins it in DIPO-70.

import type { Clock, Origin } from "@dipsaus-orchestrator/contract";

import { ClientError, DipoClient } from "../client";
import { systemClock } from "./clock";
import { type Env, readRuntimeInfo, type RuntimeInfo, stateDir } from "./runtime";
import { unixSocketTransport } from "./transport";

export { systemClock } from "./clock";
export { readRuntimeInfo, RUNTIME_FILE, stateDir } from "./runtime";
export type { Env, RuntimeInfo } from "./runtime";
export { unixSocketTransport } from "./transport";

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
