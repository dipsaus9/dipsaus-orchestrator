// The `dipo` command line: `--version`, `--help`, the daemon-side forms, the daemon subcommands and
// the hidden `self-check`; later stories add subcommands. Daemon-side forms go through `runDaemon`
// (0004, 0006 decision 2); every other subcommand goes through `client`.

import {
  autostartReport,
  connectOrStart,
  inspectDaemon,
  installDaemon,
  readSoftwareConfig,
  restartDaemon,
  startDaemon,
  stateDir,
  stopDaemon,
  systemClock,
  systemLifecycleDeps,
  uninstallDaemon,
  versionHint,
} from "@dipsaus-orchestrator/client/node";
import type { Clock } from "@dipsaus-orchestrator/contract";
import { runDaemon } from "@dipsaus-orchestrator/daemon";
import { checkInk, INK_SELF_CHECK_NAME } from "@dipsaus-orchestrator/tui";

import { type ConnectDaemon, DAEMON_SUBCOMMANDS, type DaemonControl } from "./daemon-commands";
import { gateCommand } from "./gate-command";
import type { DaemonLogsDeps } from "./logs-command";
import { OFFICE_SUBCOMMANDS } from "./office-commands";
import { runCommand } from "./run-command";
import { stopCommand } from "./stop-command";
import { statsCommand } from "./stats-command";
import {
  compiledStamp,
  currentRuntime,
  formatVersion,
  formatVersionJson,
  versionInfo,
  type BuildStamp,
  type Runtime,
} from "./version";
import { systemWorkspace, type Workspace } from "./workspace";

export const packageName = "@dipsaus-orchestrator/cli";

export type ClientCheck = { readonly name: string; readonly run: () => Promise<void> | void };

export type CliDeps = {
  readonly writeLine: (line: string) => void;
  readonly writeError: (line: string) => void;
  readonly runDaemon: (argv: readonly string[]) => Promise<number>;
  readonly connectDaemon: ConnectDaemon;
  readonly daemon: DaemonControl;
  readonly clock: Clock;
  readonly clientChecks: readonly ClientCheck[];
  readonly stamp: BuildStamp | undefined;
  readonly runtime: Runtime;
  /** The current directory, the terminal and git around it (`dipo office`, DIPO-27). */
  readonly workspace: Workspace;
  /** Where `dipo daemon logs` reads; defaults to `<logs>` of this user (DIPO-64). */
  readonly logs?: DaemonLogsDeps;
};

export const HELP = `dipo: run your software products with a model as your team

Usage:
  dipo [options]
  dipo daemon start [--log-level <level>]
                    start the daemon in the background and wait up to 5 s for it
  dipo daemon stop [--force]
                    stop the daemon; --force signals an unresponsive one
                    (SIGTERM, then SIGKILL after 10 s)
  dipo daemon restart [--log-level <level>]
                    stop the daemon and start this binary's version
  dipo daemon status [--json]
                    running (exit 0), unresponsive (exit 1), not running or
                    stale (exit 3); also whether autostart is installed
  dipo daemon install
                    run the daemon under launchd (macOS) or a systemd user unit
                    (Linux): started at login, restarted after a crash; start,
                    stop and restart then go through the supervisor
  dipo daemon uninstall
                    stop the supervised daemon and remove the launchd agent or
                    systemd unit
  dipo daemon --foreground [--log-level <level>]
                    run the daemon in this terminal; logs also go to stderr
  dipo daemon logs [-f] [--office <id>] [--run <id>] [--level <level>]
                    print daemon.log and its rotated files, also with the daemon
                    stopped; -f keeps following, --level keeps that level and
                    the more severe ones
  dipo daemon log-level <level>
                    set the running daemon's log level until it restarts
                    (error, warn, info, debug or trace)
  dipo daemon resume-scheduling
                    leave safe mode so the daemon schedules work again
  dipo office open [path]
                    register the git repository with Backlog.md at path (default:
                    the current directory) as an office
  dipo office forget [--office <id>] [--yes]
                    remove the office from the list; its repository and history
                    are kept
  dipo office init [--office <id>]
                    prepare the office's Backlog.md settings for dipo's lifecycle
                    and move To Do stories to Refined, through one backlog PR
                    that dipo opens and merges once its checks pass
  dipo office reload-config [--office <id>]
                    read the office configuration again; an invalid file keeps
                    the previous one and refuses new runs
  dipo gate <id> [--office <id>]
                    check a story against the Ready gate on the office's base
                    branch without storing anything; prints "ready <ID> passed"
                    or each failure, and exits 1 when any rule fails
  dipo run [<id>...] [--office <id>]
                    pick the first Ready story on the office's base branch (or
                    the named ones), claim it and start its run; prints each
                    started story and each skipped one with its reason, and
                    exits 1 when none started
  dipo run --dry-run [<id>...] [--office <id>]
                    show what dipo run would do without doing it: the branch and
                    worktree it would create, the full worker launch (program,
                    arguments, model, effort, caps, sandbox settings, variable
                    names) and the system file and task message the worker
                    would get; claims, creates and starts nothing
  dipo stop <id> [--note <text>] [--office <id>] [--yes]
                    stop the story's worker after asking; the story parks as
                    stopped with branch and worktree kept
  dipo office rescan [--office <id>]
                    scan the office's run profile again and print what changed,
                    its conformance level and each deviation
  dipo stats [--office <id>]
                    print the rows and approximate bytes of each table of the
                    office, to tune retention.shortDays and retention.stateDays

Office commands use --office, else the office of the current directory.

Commands that need the daemon start it unless daemon.autostart is false in
<state>/config.yaml.

Options:
  --version         print the version, commit, Bun version and platform
  --version --json  print the same fields as JSON
  -h, --help        print this help`;

/** `dipo daemon` forms that run daemon-side code; the lifecycle subcommands go through `client`. */
export const DAEMON_FORMS: ReadonlySet<string> = new Set([
  "--foreground",
  "worker-host",
  "wait-pid",
  "sandbox-exec",
]);

export function defaultDeps(): CliDeps {
  const stamp = compiledStamp();
  const runtime = currentRuntime();
  const { version } = versionInfo(stamp, runtime);
  const lifecycle = systemLifecycleDeps({ client: { name: "dipo-cli", version }, origin: "cli" });
  return {
    writeLine: (line) => process.stdout.write(`${line}\n`),
    writeError: (line) => process.stderr.write(`${line}\n`),
    runDaemon: (argv) => runDaemon(argv, { version }),
    connectDaemon: async () => {
      const { session, started } = await connectOrStart(lifecycle);
      if (started !== null) {
        process.stderr.write(
          `dipo: started the daemon (pid ${started.pid}, version ${started.version})\n`,
        );
      }
      const hint = versionHint(version, session.hello?.engine);
      if (hint !== null) process.stderr.write(`dipo: ${hint}\n`);
      return session;
    },
    daemon: {
      inspect: () => inspectDaemon(lifecycle),
      start: (options) => startDaemon(lifecycle, options),
      stop: (options) => stopDaemon(lifecycle, options),
      restart: (options) => restartDaemon(lifecycle, options),
      install: () => installDaemon(lifecycle),
      uninstall: () => uninstallDaemon(lifecycle),
      autostart: async () =>
        lifecycle.supervisor === undefined ? null : autostartReport(lifecycle.supervisor),
      configErrors: () => {
        const config = readSoftwareConfig(stateDir(lifecycle.env));
        return config.ok ? null : config.errors;
      },
    },
    clock: systemClock,
    workspace: systemWorkspace(),
    clientChecks: [{ name: INK_SELF_CHECK_NAME, run: checkInk }],
    stamp,
    runtime,
  };
}

/** Runs the command line and resolves to the process exit code. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    deps.writeLine(HELP);
    return 0;
  }
  if (args[0] === "--version") {
    const rest = args.slice(1);
    const info = versionInfo(deps.stamp, deps.runtime);
    if (rest.length === 0) {
      deps.writeLine(formatVersion(info));
      return 0;
    }
    if (rest.length === 1 && rest[0] === "--json") {
      deps.writeLine(formatVersionJson(info));
      return 0;
    }
  }
  if (args[0] === "daemon" && DAEMON_FORMS.has(args[1] ?? "")) {
    return deps.runDaemon(args.slice(1));
  }
  const subcommand = args[0] === "daemon" ? DAEMON_SUBCOMMANDS.get(args[1] ?? "") : undefined;
  if (subcommand !== undefined) {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return subcommand(args.slice(2), { ...deps, version });
  }
  const office = args[0] === "office" ? OFFICE_SUBCOMMANDS.get(args[1] ?? "") : undefined;
  if (office !== undefined) {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return office(args.slice(2), { ...deps, version });
  }
  if (args[0] === "gate") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return gateCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "run") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return runCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "stop") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return stopCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "stats") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return statsCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "self-check" && args.length === 1) {
    return selfCheck(deps);
  }
  deps.writeError(`dipo: unknown arguments: ${args.join(" ")}\nRun \`dipo --help\` for usage.`);
  return 2;
}

// Hidden: probes the runtime features the daemon (through `runDaemon`) and the TUI rely on inside the
// compiled binary. One line per check; stops with a non-zero code at the first failure.
async function selfCheck(deps: CliDeps): Promise<number> {
  const daemonCode = await deps.runDaemon(["self-check"]);
  if (daemonCode !== 0) return daemonCode;
  for (const check of deps.clientChecks) {
    try {
      await check.run();
    } catch (error) {
      deps.writeLine(
        `fail ${check.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    deps.writeLine(`ok   ${check.name}`);
  }
  return 0;
}
