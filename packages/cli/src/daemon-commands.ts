// `dipo daemon` client subcommands (0006 decisions 2, 5, 14 and 15). `start`, `stop`, `restart`,
// `status`, `install` and `uninstall` go through the `lifecycle` module of `client/node`; `log-level` and `resume-scheduling`
// send one contract command each, starting the daemon first unless `daemon.autostart` is false;
// `logs` reads the log files directly and never talks to the daemon (DIPO-64). Read-only commands
// connect with `ConnectMode` `running` and never start it (DIPO-187).

import type { DipoClient } from "@dipsaus-orchestrator/client";
import { ClientError, type RecoveringSession, waitForRecovery } from "@dipsaus-orchestrator/client";
import {
  AutostartOffError,
  DaemonNotRunningError,
  DaemonStartError,
  describeStartFailure,
  lingerWarning,
  logsDir,
  SoftwareConfigError,
  versionHint,
  type DaemonObservation,
  type AutostartReport,
  type DaemonStatusResult,
  type InstallResult,
  type RestartResult,
  type StartOptions,
  type StartResult,
  type StopResult,
  type UninstallResult,
} from "@dipsaus-orchestrator/client/node";
import {
  cleanText,
  type Clock,
  type ConfigError,
  ContractUnsupportedDetails,
  daemonResumeScheduling,
  daemonSetLogLevel,
  type EngineError,
  LogLevel,
} from "@dipsaus-orchestrator/contract";

import { type DaemonLogsDeps, logsCommand } from "./logs-command";

/** What a daemon subcommand needs from a connected client. */
export type DaemonSession = Pick<DipoClient, "command" | "read" | "subscribe" | "close">;

/**
 * `start` connects and starts the daemon when autostart allows (DIPO-70); `running` connects to a
 * daemon that is already up and never starts one (read-only commands, DIPO-187).
 */
export type ConnectMode = "start" | "running";

/**
 * Connects to the daemon, starting it first when `mode` is `start` and autostart allows (DIPO-70).
 * Throws `DaemonNotRunningError`, `AutostartOffError`, `SoftwareConfigError` or `DaemonStartError`.
 */
export type ConnectDaemon = (mode: ConnectMode) => Promise<DaemonSession>;

/** The lifecycle operations, injectable so the commands are tested without processes. */
export interface DaemonControl {
  inspect(): Promise<DaemonObservation>;
  start(options: StartOptions): Promise<StartResult>;
  stop(options: { readonly force: boolean }): Promise<StopResult>;
  restart(options: StartOptions): Promise<RestartResult>;
  /** `dipo daemon install|uninstall` (0006 decision 15, DIPO-63). */
  install?(): Promise<InstallResult>;
  uninstall?(): Promise<UninstallResult>;
  /** Autostart for `status`: installed or not, the binary it runs, lingering on Linux. */
  autostart?(): Promise<AutostartReport | null>;
  /** `<state>/config.yaml` problems, which make the daemon refuse to start (exit 78). */
  configErrors?(): readonly ConfigError[] | null;
}

/**
 * `deps` whose output lines pass through the shared cleaner, so no terminal control character in
 * text from a worker, a repository, a story or a notice reaches the terminal (DIPO-313).
 */
export function cleanedOutput<T extends Pick<DaemonCommandDeps, "writeLine" | "writeError">>(
  deps: T,
): T {
  return {
    ...deps,
    writeLine: (line: string) => deps.writeLine(cleanText(line)),
    writeError: (line: string) => deps.writeError(cleanText(line)),
  };
}

export interface DaemonCommandDeps {
  readonly writeLine: (line: string) => void;
  readonly writeError: (line: string) => void;
  readonly connectDaemon: ConnectDaemon;
  readonly daemon: DaemonControl;
  readonly clock: Clock;
  /** This binary's version, for the restart hint of 0006 decision 14. */
  readonly version: string;
  /** Where `dipo daemon logs` reads; defaults to `<logs>` of this user (0006 decision 3). */
  readonly logs?: DaemonLogsDeps;
}

/** How long a subcommand waits for its reply, reconnects included. */
export const REPLY_TIMEOUT_MS = 10_000;

export const START_HINT = "Start it with `dipo daemon start`.";

/** Printed once when a command has waited about a second for a recovering daemon (DIPO-86). */
export const RECOVERY_WAIT = "waiting for the daemon to finish recovering";

/** Printed once when the daemon a command waited for ended its recovery in `safe` (DIPO-86). */
export function safeModeLine(reason: string | undefined): string {
  const why = reason === undefined ? "" : ` (${reason})`;
  return `the daemon finished recovering in safe mode${why}: scheduling is off until you run \`dipo daemon resume-scheduling\`.`;
}

/** Exit codes of `dipo daemon status` (0006 decision 5). */
export const STATUS_EXIT = { running: 0, unresponsive: 1, notRunning: 3 } as const;

type Subcommand = (args: readonly string[], deps: DaemonCommandDeps) => Promise<number>;

export function usage(deps: Pick<DaemonCommandDeps, "writeError">, message: string): number {
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
  const keepAwake = status.keepAwake.held
    ? `held${status.keepAwake.reason === undefined ? "" : ` (${status.keepAwake.reason})`}`
    : `not held${status.keepAwake.reason === undefined ? "" : `: ${status.keepAwake.reason}`}`;
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
    `  keep-awake: ${keepAwake}`,
  );
  if (status.buildCommit !== undefined) lines.push(`  commit:     ${status.buildCommit}`);
  for (const behind of status.engineBehind ?? []) {
    if (behind.commits === 0) continue;
    const plural = behind.commits === 1 ? "commit" : "commits";
    lines.push(
      `  ${behind.name ?? behind.office}: the base has ${behind.commits} engine ${plural} after this build; rebuild dipo and run \`dipo daemon restart\``,
    );
  }
  if (status.upgradePending) {
    lines.push("  upgrade pending: the binary changed on disk; run `dipo daemon restart`");
  }
  lines.push("  tools:");
  for (const tool of TOOL_ORDER) {
    lines.push(`    ${tool.padEnd(8)}${status.tools[tool] ?? "missing"}`);
  }
  return lines;
}

/** The autostart line of `status` and its warnings (0006 decision 15). */
function printAutostart(deps: DaemonCommandDeps, report: AutostartReport | null): void {
  if (report === null) return;
  deps.writeLine(
    report.installed
      ? `  autostart:  ${report.supervisor} (${report.file})`
      : "  autostart:  not installed (`dipo daemon install`)",
  );
  if (report.programMissing) {
    deps.writeError(
      `dipo: the installed autostart runs ${report.program}, which no longer exists; run \`dipo daemon install\` again from the binary you use now.`,
    );
  }
}

function warnLingering(deps: DaemonCommandDeps, report: AutostartReport | null) {
  if (report?.lingering === false) deps.writeError(`dipo: ${lingerWarning(report.user)}`);
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
  const autostart = (await deps.daemon.autostart?.()) ?? null;
  const code =
    observed.kind === "running" || observed.kind === "foreign"
      ? STATUS_EXIT.running
      : observed.kind === "unresponsive"
        ? STATUS_EXIT.unresponsive
        : STATUS_EXIT.notRunning;
  if (json) {
    deps.writeLine(
      JSON.stringify({ ...statusJson(observed), ...(autostart === null ? {} : { autostart }) }),
    );
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
      // A daemon that refuses its config.yaml exits 78 and is not restarted (DIPO-69, DIPO-63):
      // the client reads the same file to say why.
      for (const error of deps.daemon.configErrors?.() ?? []) {
        deps.writeError(`dipo: the daemon refuses to start: ${error.message}`);
      }
  }
  printAutostart(deps, autostart);
  warnLingering(deps, autostart);
  return code;
}

function printInstall(deps: DaemonCommandDeps, result: InstallResult): number {
  switch (result.kind) {
    case "unsupported":
      deps.writeError("dipo: autostart needs launchd (macOS) or systemd (Linux).");
      return 1;
    case "config":
      for (const error of result.errors) deps.writeError(`dipo: ${error.message}`);
      deps.writeError("dipo: nothing was installed; fix the file and run `dipo daemon install`.");
      return 1;
    case "stop failed":
      deps.writeError("dipo: nothing was installed; the running daemon did not stop.");
      return printStop(deps, result.stop);
    case "failed":
      deps.writeError(`dipo: could not install ${result.file}: ${result.message}`);
      return 1;
    default: {
      if (result.stopped !== null) deps.writeLine(`dipo daemon stopped (pid ${result.stopped})`);
      deps.writeLine(`installed ${result.file}`);
      for (const command of result.commands) deps.writeLine(`  ran: ${command}`);
      deps.writeLine(
        result.supervisor === "launchd"
          ? "launchd starts the daemon at login and restarts it after a crash."
          : "systemd starts the daemon with your user manager and restarts it after a crash.",
      );
      if (result.lingering === false) deps.writeError(`dipo: ${lingerWarning(result.user)}`);
      return printStart(deps, result.start);
    }
  }
}

function printUninstall(deps: DaemonCommandDeps, result: UninstallResult): number {
  switch (result.kind) {
    case "unsupported":
      deps.writeError("dipo: autostart needs launchd (macOS) or systemd (Linux).");
      return 1;
    case "not installed":
      deps.writeLine(`autostart is not installed (${result.file} does not exist)`);
      return 0;
    case "failed":
      deps.writeError(`dipo: could not uninstall ${result.file}: ${result.message}`);
      return 1;
    default:
      for (const command of result.commands) deps.writeLine(`  ran: ${command}`);
      deps.writeLine(`removed ${result.file}`);
      deps.writeLine(
        result.stopped === null
          ? "no supervised daemon was running."
          : `dipo daemon stopped (pid ${result.stopped}); \`dipo daemon start\` starts it without autostart.`,
      );
      return 0;
  }
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
    "install",
    async (args, deps) => {
      if (args.length !== 0) return usage(deps, "daemon install takes no arguments");
      if (deps.daemon.install === undefined) return usage(deps, "daemon install is not available");
      return printInstall(deps, await deps.daemon.install());
    },
  ],
  [
    "uninstall",
    async (args, deps) => {
      if (args.length !== 0) return usage(deps, "daemon uninstall takes no arguments");
      if (deps.daemon.uninstall === undefined) {
        return usage(deps, "daemon uninstall is not available");
      }
      return printUninstall(deps, await deps.daemon.uninstall());
    },
  ],
  [
    "logs",
    (args, deps) =>
      logsCommand(args, { ...deps, logs: deps.logs ?? { dir: logsDir() } }, (message) =>
        usage(deps, message),
      ),
  ],
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

export function engineFailure(deps: DaemonCommandDeps, error: EngineError): number {
  deps.writeError(`dipo: ${error.code}: ${error.message}`);
  return 1;
}

/**
 * Connects, runs one exchange under the reply deadline (`timeoutMs`, `REPLY_TIMEOUT_MS` by
 * default; `Infinity` for none, as `dipo watch` runs until stopped), and always closes the
 * connection. A daemon still starting or recovering is waited for inside that deadline (DIPO-86):
 * the session sends a request refused with `engine.recovering` again once `daemon.status` leaves
 * `starting` and `recovering`.
 */
export async function withDaemon(
  deps: DaemonCommandDeps,
  run: (session: DaemonSession) => Promise<number>,
  timeoutMs: number = REPLY_TIMEOUT_MS,
  mode: ConnectMode = "start",
): Promise<number> {
  let session: RecoveringSession;
  try {
    session = waitForRecovery(await deps.connectDaemon(mode), {
      clock: deps.clock,
      onWaiting: () => deps.writeError(`dipo: ${RECOVERY_WAIT}`),
      onSafe: (reason) => deps.writeError(`dipo: ${safeModeLine(reason)}`),
    });
  } catch (error) {
    return failure(deps, error);
  }
  let timer: ReturnType<Clock["setTimeout"]> | null = null;
  const deadline = new Promise<number>((resolve) => {
    if (!Number.isFinite(timeoutMs)) return;
    timer = deps.clock.setTimeout(() => {
      deps.writeError(
        session.waiting
          ? `dipo: the daemon was still recovering after ${timeoutMs / 1000} s; try again shortly, or see \`dipo daemon status\`.`
          : `dipo: the daemon did not answer within ${timeoutMs / 1000} s.`,
      );
      resolve(1);
    }, timeoutMs);
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
