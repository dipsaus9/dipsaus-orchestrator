// `dipo daemon` subcommands that act on a running daemon (0006 decisions 2 and 5): each sends one
// contract command through `client` and prints the reply. Starting the daemon when it is not
// running (autostart) arrives with DIPO-70; until then these commands say how to start it.

import type { DipoClient } from "@dipsaus-orchestrator/client";
import { ClientError } from "@dipsaus-orchestrator/client";
import { DaemonNotRunningError } from "@dipsaus-orchestrator/client/node";
import {
  type Clock,
  daemonResumeScheduling,
  daemonSetLogLevel,
  type EngineError,
  LogLevel,
} from "@dipsaus-orchestrator/contract";

/** What a daemon subcommand needs from a connected client. */
export type DaemonSession = Pick<DipoClient, "command" | "close">;

/** Connects to the running daemon; throws `DaemonNotRunningError` when none answers. */
export type ConnectDaemon = () => Promise<DaemonSession>;

export interface DaemonCommandDeps {
  readonly writeLine: (line: string) => void;
  readonly writeError: (line: string) => void;
  readonly connectDaemon: ConnectDaemon;
  readonly clock: Clock;
}

/** How long a subcommand waits for its reply, reconnects included. */
export const REPLY_TIMEOUT_MS = 10_000;

/** `dipo daemon start` arrives with DIPO-70; until then the foreground form is the way to start. */
export const START_HINT =
  "Start it with `dipo daemon start` (until that exists: `dipo daemon --foreground`).";

type Subcommand = (args: readonly string[], deps: DaemonCommandDeps) => Promise<number>;

export const DAEMON_SUBCOMMANDS: ReadonlyMap<string, Subcommand> = new Map<string, Subcommand>([
  [
    "log-level",
    async (args, deps) => {
      const level = LogLevel.safeParse(args[0]);
      if (args.length !== 1 || !level.success) {
        deps.writeError(
          `dipo: daemon log-level needs one level: ${LogLevel.options.join(", ")}\nRun \`dipo --help\` for usage.`,
        );
        return 2;
      }
      return withDaemon(deps, async (session) => {
        const outcome = await session.command(daemonSetLogLevel, { level: level.data });
        if (!outcome.ok) return engineFailure(deps, outcome.error);
        deps.writeLine(
          outcome.changed
            ? `daemon log level: ${outcome.result.level} (until the daemon restarts)`
            : `daemon log level: ${outcome.result.level} (unchanged)`,
        );
        return 0;
      });
    },
  ],
  [
    "resume-scheduling",
    async (args, deps) => {
      if (args.length !== 0) {
        deps.writeError(
          "dipo: daemon resume-scheduling takes no arguments\nRun `dipo --help` for usage.",
        );
        return 2;
      }
      return withDaemon(deps, async (session) => {
        const outcome = await session.command(daemonResumeScheduling, {});
        if (!outcome.ok) return engineFailure(deps, outcome.error);
        deps.writeLine(`scheduling resumed; daemon state: ${outcome.result.state}`);
        return 0;
      });
    },
  ],
]);

function engineFailure(deps: DaemonCommandDeps, error: EngineError): number {
  deps.writeError(`dipo: ${error.code}: ${error.message}`);
  return 1;
}

/** Connects, runs one exchange under the reply deadline, and always closes the connection. */
async function withDaemon(
  deps: DaemonCommandDeps,
  run: (session: DaemonSession) => Promise<number>,
): Promise<number> {
  let session: DaemonSession;
  try {
    session = await deps.connectDaemon();
  } catch (error) {
    return failure(deps, error);
  }
  let timer: ReturnType<Clock["setTimeout"]> | null = null;
  const deadline = new Promise<number>((resolve) => {
    timer = deps.clock.setTimeout(() => {
      deps.writeError(`dipo: the daemon did not answer within ${REPLY_TIMEOUT_MS / 1000} s.`);
      resolve(1);
    }, REPLY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(session), deadline]);
  } catch (error) {
    return failure(deps, error);
  } finally {
    if (timer !== null) deps.clock.clearTimeout(timer);
    session.close();
  }
}

function failure(deps: DaemonCommandDeps, error: unknown): number {
  if (error instanceof DaemonNotRunningError) {
    deps.writeError(`dipo: ${error.message}. ${START_HINT}`);
    return 1;
  }
  if (error instanceof ClientError) {
    deps.writeError(`dipo: ${error.code}: ${error.message}`);
    return 1;
  }
  deps.writeError(`dipo: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
}
