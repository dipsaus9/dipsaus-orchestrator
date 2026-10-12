// `dipo daemon` client subcommands (0006 decisions 2, 5 and 14). `start`, `stop`, `restart` and
// `status` go through the `lifecycle` module of `client/node`; `log-level` and `resume-scheduling`
// send one contract command each, starting the daemon first unless `daemon.autostart` is false.

import type { DipoClient } from "@dipsaus-orchestrator/client";
import { ClientError } from "@dipsaus-orchestrator/client";
import {
  AutostartOffError,
  DaemonNotRunningError,
  DaemonStartError,
  describeStartFailure,
  SoftwareConfigError,
  versionHint,
  type DaemonObservation,
  type DaemonStatusResult,
  type RestartResult,
  type StartOptions,
  type StartResult,
  type StopResult,
} from "@dipsaus-orchestrator/client/node";
import {
  type Clock,
  ContractUnsupportedDetails,
  daemonResumeScheduling,
  daemonSetLogLevel,
  type EngineError,
  LogLevel,
} from "@dipsaus-orchestrator/contract";

/** What a daemon subcommand needs from a connected client. */
export type DaemonSession = Pick<DipoClient, "command" | "close">;

/**
 * Connects to the daemon, starting it first when autostart allows (DIPO-70). Throws
 * `DaemonNotRunningError`, `AutostartOffError`, `SoftwareConfigError` or `DaemonStartError`.
 */
export type ConnectDaemon = () => Promise<DaemonSession>;

/** The lifecycle operations, injectable so the commands are tested without processes. */
export interface DaemonControl {
  inspect(): Promise<DaemonObservation>;
  start(options: StartOptions): Promise<StartResult>;
  stop(options: { readonly force: boolean }): Promise<StopResult>;
  restart(options: StartOptions): Promise<RestartResult>;
}

export interface DaemonCommandDeps {
  readonly writeLine: (line: string) => void;
  readonly writeError: (line: string) => void;
  readonly connectDaemon: ConnectDaemon;
  readonly daemon: DaemonControl;
  readonly clock: Clock;
  /** This binary's version, for the restart hint of 0006 decision 14. */
  readonly version: string;
}

/** How long a subcommand waits for its reply, reconnects included. */
export const REPLY_TIMEOUT_MS = 10_000;

export const START_HINT = "Start it with `dipo daemon start`.";

/** Exit codes of `dipo daemon status` (0006 decision 5). */
export const STATUS_EXIT = { running: 0, unresponsive: 1, notRunning: 3 } as const;

type Subcommand = (args: readonly string[], deps: DaemonCommandDeps) => Promise<number>;

function usage(deps: DaemonCommandDeps, message: string): number {
  deps.writeError(`dipo: ${message}\nRun \`dipo --help\` for usage.`);
  return 2;
}

/** Parses `[--log-level <level>]`; a string is an error message. */
function parseStartArgs(args: readonly string[]): StartOptions | string {
  if (args.length === 0) return {};
  const level = LogLevel.safeParse(args[1]);
  if (args.length === 2 && args[0] === "--log-level" && level.success) {
    return { logLevel: level.data };
  }
  return `the only option is --log-level <${LogLevel.options.join("|")}>`;
}

function printStart(deps: DaemonCommandDeps, result: StartResult): number {
  switch (result.kind) {
    case "started":
      deps.writeLine(`dipo daemon started (pid ${result.pid}, version ${result.version})`);
      return 0;
    case "already running": {
      deps.writeLine(
        `dipo daemon is already running (pid ${result.pid}, version ${result.version})`,
      );
      const hint = versionHint(deps.version, result.version);
      if (hint !== null) deps.writeError(`dipo: ${hint}`);
      return 0;
    }
    case "config":
      for (const error of result.errors) deps.writeError(`dipo: ${error.message}`);
      deps.writeError(
        "dipo: the daemon was not started; fix the file and run `dipo daemon start`.",
      );
      return 1;
    default:
      deps.writeError(`dipo: ${describeStartFailure(result)}`);
      return 1;
  }
}

function formatUptime(ms: number): string {
  let seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const parts = [
    days > 0 ? `${days}d` : "",
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    `${seconds}s`,
  ];
  return parts.filter((part) => part !== "").join(" ");
}

const TOOL_ORDER = ["claude", "backlog", "gh", "rg", "git"] as const;

/** The `running` report: state and reason, PID, version, uptime, socket and tool paths. */
export function formatRunning(status: DaemonStatusResult): string[] {
  const reason = status.stateReason === undefined ? "" : ` (${status.stateReason})`;
  const keepAwakeReason =
    status.keepAwake.reason === undefined ? "" : ` (${status.keepAwake.reason})`;
  const lines = [
    "running",
    `  state:      ${status.state}${reason}`,
    `  pid:        ${status.pid}`,
    `  version:    ${status.version}`,
    `  uptime:     ${formatUptime(status.uptimeMs)}`,
    `  socket:     ${status.socket}`,
  ];
  if (status.webUrl !== undefined) lines.push(`  web:        ${status.webUrl}`);
  lines.push(
    `  offices:    ${status.loadedOffices.length} loaded, ${status.activeRuns} active runs`,
    `  keep-awake: ${status.keepAwake.held ? "held" : "not held"}${keepAwakeReason}`,
  );
  if (status.upgradePending) {
    lines.push("  upgrade pending: the binary changed on disk; run `dipo daemon restart`");
  }
  lines.push("  tools:");
  for (const tool of TOOL_ORDER) {
    lines.push(`    ${tool.padEnd(8)}${status.tools[tool] ?? "missing"}`);
  }
  return lines;
}

function statusJson(observed: DaemonObservation): Record<string, unknown> {
  switch (observed.kind) {
    case "running":
      return { status: "running", daemon: observed.status };
    case "foreign":
      return {
        status: "running",
        pid: observed.record.pid,
        version: observed.details?.version ?? observed.record.version,
        contract: observed.details?.contract ?? null,
        contractSupported: false,
      };
    case "unresponsive":
      return { status: "unresponsive", pid: observed.record.pid };
    default:
      return observed.cleaned.length > 0
        ? { status: "stale", cleaned: observed.cleaned }
        : { status: "not running" };
  }
}

async function statusCommand(args: readonly string[], deps: DaemonCommandDeps): Promise<number> {
  const json = args.length === 1 && args[0] === "--json";
  if (args.length > 0 && !json) return usage(deps, "daemon status takes only --json");
  const observed = await deps.daemon.inspect();
  const code =
    observed.kind === "running" || observed.kind === "foreign"
      ? STATUS_EXIT.running
      : observed.kind === "unresponsive"
        ? STATUS_EXIT.unresponsive
        : STATUS_EXIT.notRunning;
  if (json) {
    deps.writeLine(JSON.stringify(statusJson(observed)));
    return code;
  }
  switch (observed.kind) {
    case "running": {
      for (const line of formatRunning(observed.status)) deps.writeLine(line);
      const hint = versionHint(deps.version, observed.status.version);
      if (hint !== null) deps.writeError(`dipo: ${hint}`);
      break;
    }
    case "foreign": {
      const version = observed.details?.version ?? observed.record.version;
      deps.writeLine("running");
      deps.writeLine(`  pid:        ${observed.record.pid}`);
      deps.writeLine(`  version:    ${version} (another contract major)`);
      deps.writeError(`dipo: ${versionHint(deps.version, version) ?? "run `dipo daemon restart`"}`);
      break;
    }
    case "unresponsive":
      deps.writeLine("unresponsive");
      deps.writeLine(
        `  pid ${observed.record.pid} is a dipo daemon but its socket does not answer; run \`dipo daemon stop --force\``,
      );
      break;
    default:
      if (observed.cleaned.length > 0) {
        deps.writeLine("stale");
        deps.writeLine(
          `  removed leftovers of a daemon that is gone: ${observed.cleaned.join(", ")}`,
        );
      } else {
        deps.writeLine("not running");
      }
  }
  return code;
}

function printStop(deps: DaemonCommandDeps, result: StopResult): number {
  switch (result.kind) {
    case "not running":
      deps.writeLine(
        result.cleaned.length > 0
          ? `dipo daemon is not running (removed stale ${result.cleaned.join(", ")})`
          : "dipo daemon is not running",
      );
      return 0;
    case "stopped":
      deps.writeLine(
        result.killed
          ? `dipo daemon stopped (pid ${result.pid}, killed after 10 s)`
          : `dipo daemon stopped (pid ${result.pid})`,
      );
      return 0;
    case "unresponsive":
      deps.writeError(
        `dipo: the daemon (pid ${result.pid}) does not answer. Run \`dipo daemon stop --force\` to stop it.`,
      );
      return 1;
    case "refused":
      deps.writeError(`dipo: the daemon (pid ${result.pid}) did not stop: ${result.message}`);
      return 1;
    default:
      deps.writeError(
        `dipo: the daemon (pid ${result.pid}) is still running; check \`dipo daemon status\`.`,
      );
      return 1;
  }
}

export const DAEMON_SUBCOMMANDS: ReadonlyMap<string, Subcommand> = new Map<string, Subcommand>([
  [
    "start",
    async (args, deps) => {
      const options = parseStartArgs(args);
      if (typeof options === "string") return usage(deps, `daemon start: ${options}`);
      return printStart(deps, await deps.daemon.start(options));
    },
  ],
  [
    "stop",
    async (args, deps) => {
      const force = args.length === 1 && args[0] === "--force";
      if (args.length > 0 && !force) return usage(deps, "daemon stop takes only --force");
      return printStop(deps, await deps.daemon.stop({ force }));
    },
  ],
  [
    "restart",
    async (args, deps) => {
      const options = parseStartArgs(args);
      if (typeof options === "string") return usage(deps, `daemon restart: ${options}`);
      const result = await deps.daemon.restart(options);
      if (result.kind === "config") {
        for (const error of result.errors) deps.writeError(`dipo: ${error.message}`);
        deps.writeError("dipo: nothing was restarted; fix the file and run `dipo daemon restart`.");
        return 1;
      }
      if (result.kind === "stop failed") return printStop(deps, result.stop);
      if (result.stopped !== null) deps.writeLine(`dipo daemon stopped (pid ${result.stopped})`);
      return printStart(deps, result.start);
    },
  ],
  ["status", statusCommand],
  [
    "log-level",
    async (args, deps) => {
      const level = LogLevel.safeParse(args[0]);
      if (args.length !== 1 || !level.success) {
        return usage(deps, `daemon log-level needs one level: ${LogLevel.options.join(", ")}`);
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
      if (args.length !== 0) return usage(deps, "daemon resume-scheduling takes no arguments");
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
  if (
    error instanceof AutostartOffError ||
    error instanceof SoftwareConfigError ||
    error instanceof DaemonStartError
  ) {
    deps.writeError(`dipo: ${error.message}`);
    return 1;
  }
  if (error instanceof ClientError) {
    deps.writeError(`dipo: ${error.code}: ${error.message}`);
    if (error.code === "contract.unsupported") {
      const details = ContractUnsupportedDetails.safeParse(error.engineError?.details);
      const hint = details.success ? versionHint(deps.version, details.data.version) : null;
      deps.writeError(`dipo: ${hint ?? "run `dipo daemon restart`"}`);
    }
    return 1;
  }
  deps.writeError(`dipo: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
}
