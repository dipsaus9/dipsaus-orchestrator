// Connecting to a running daemon: the socket named in `<state>/runtime.json`, then `engine.hello`.
// Client and daemon are one binary (0005): a daemon of another version, or one that refuses this
// binary's `engine.hello`, is `OtherVersionError`, and only `dipo daemon restart` helps.

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

/** The hello refusals of a daemon that speaks another contract. */
const FOREIGN_HELLO_CODES: ReadonlySet<string> = new Set(["args.invalid", "not.permitted"]);

/** The client-side code of a daemon of another version. */
export const OTHER_VERSION = "client.otherVersion";

/**
 * The daemon runs another version of dipo (0005): its `engine.hello` names another version, or it
 * refused this binary's hello. `daemonVersion` is null when the daemon did not say.
 */
export class OtherVersionError extends ClientError {
  constructor(
    readonly daemonVersion: string | null,
    readonly ownVersion: string,
  ) {
    super(
      OTHER_VERSION,
      `daemon runs ${daemonVersion === null ? "another version" : `v${daemonVersion}`}, this binary is v${ownVersion}, run \`dipo daemon restart\``,
    );
    this.name = "OtherVersionError";
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
 * `DaemonNotRunningError` when there is no record or nothing answers on its socket, and
 * `OtherVersionError` when the daemon runs another version or refuses the hello.
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
  let engine: string;
  try {
    ({ engine } = await client.connect(
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ));
  } catch (error) {
    if (error instanceof ClientError && error.code === "client.unreachable") {
      throw new DaemonNotRunningError(state, `nothing answers on ${runtime.socket}`);
    }
    // A daemon that refuses the hello's shape speaks another contract: it answers `args.invalid`,
    // or `not.permitted` for a frame it does not take as a hello. Any other refusal (`internal`)
    // is the daemon's own failure and stays what it is.
    const code = error instanceof ClientError ? error.engineError?.code : undefined;
    if (code !== undefined && FOREIGN_HELLO_CODES.has(code)) {
      throw new OtherVersionError(null, options.client.version);
    }
    throw error;
  }
  if (engine !== options.client.version) {
    client.close();
    throw new OtherVersionError(engine, options.client.version);
  }
  return { client, runtime };
}
