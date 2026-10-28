// The `dipo` command line: `--version`, `--help`, the daemon-side forms, the daemon subcommands and
// the hidden `self-check`; later stories add subcommands. Daemon-side forms go through `runDaemon`
// (0004, 0006 decision 2); every other subcommand goes through `client`.

import {
  autostartReport,
  connectOrStart,
  connectRunning,
  dirRefusal,
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
import { type Clock, EXIT_CONFIG } from "@dipsaus-orchestrator/contract";
import { runDaemon } from "@dipsaus-orchestrator/daemon";
import { checkInk, INK_SELF_CHECK_NAME } from "@dipsaus-orchestrator/tui";

import { answerCommand } from "./answer-command";
import { approveCommand, rejectCommand } from "./approve-commands";
import {
  type ConnectDaemon,
  type ConnectMode,
  DAEMON_SUBCOMMANDS,
  type DaemonControl,
} from "./daemon-commands";
import { deskCommand } from "./desk-command";
import { gateCommand } from "./gate-command";
import type { DaemonLogsDeps } from "./logs-command";
import { OFFICE_SUBCOMMANDS } from "./office-commands";
import { PROFILE_SUBCOMMANDS } from "./profile-commands";
import { proposeCommand } from "./propose-command";
import { runCommand } from "./run-command";
import { steerCommand } from "./intervene-commands";
import { resumeCommand } from "./resume-command";
import { discardCommand, dropCommand, parkCommand } from "./story-commands";
import { statsCommand } from "./stats-command";
import { testCommand } from "./test-commands";
import { systemTui } from "./tui-command";
import { watchCommand } from "./watch-command";
import {
  compiledStamp,
  currentRuntime,
  formatVersion,
  formatVersionJson,
  versionInfo,
  type BuildStamp,
  type Runtime,
} from "./version";
import { absolute, systemWorkspace, type Workspace } from "./workspace";

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
  /** `dipo tui` (DIPO-53); absent in tests that do not need it. */
  readonly tui?: (args: readonly string[]) => Promise<number>;
  /**
   * The refusal of a `DIPO_HOME` or `DIPO_RUNTIME_DIR` dipo cannot use (DIPO-316), checked before
   * every command but `--help`, `--version` and the daemon's own forms; absent, nothing is checked.
   */
  readonly dirRefusal?: () => { readonly code: string; readonly message: string } | null;
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
                    leave safe mode and lift every office's starts paused, so
                    the daemon schedules work again
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
  dipo office purge [--office <id>] [--yes]
                    delete the office's rows from the state database and its
                    <git-common-dir>/dipo/ directory after asking; this cannot
                    be undone
  dipo office reload-config [--office <id>]
                    read the office configuration again; an invalid file keeps
                    the previous one and refuses new runs
  dipo gate <id> [--office <id>]
                    check a story against the Ready gate on the office's base
                    branch without storing anything; prints "ready <ID> passed"
                    or each failure, and exits 1 when any rule fails
  dipo run [<id>...] [--box] [--office <id>]
                    pick the first Ready story on the office's base branch (or
                    the named ones), claim it and start its run; prints each
                    started story and each skipped one with its reason, and
                    exits 1 when none started; the worker always runs in the
                    story's own box (--box is accepted and changes nothing)
  dipo run --dry-run [<id>...] [--office <id>]
                    show what dipo run would do without doing it: the branch and
                    worktree it would create, the full worker launch (program,
                    arguments, model, effort, caps, run settings, variable
                    names) and the system file and task message the worker
                    would get; claims, creates and starts nothing
  dipo park <id> --note <text> [--office <id>]
                    park a Refined, Ready, In Progress or In Review story as
                    by-maintainer with your note: a running worker is stopped
                    first, and branch and box are kept; nothing picks it up
                    until you resume it
  dipo resume <id> [--note <text>] [--budget +<n>%|+<tokens>] [--yes] [--office <id>]
                    resume a parked story as its park reason says: a question
                    needs its answer as the note, review-blocked a note with a
                    direction, budget-exceeded --budget with a note (dipo shows
                    the caps before and after and asks first; --yes answers for
                    a script); scope-violation is not resumable
  dipo drop <id> [--delete-branch] [--yes] [--office <id>]
                    archive a Draft, Refined, Ready or Parked story after asking,
                    close its open PR and remove its worktree; its branch is
                    kept unless --delete-branch, which also removes dirty files
                    and deletes the branch locally and on the remote after you
                    type the story id
  dipo approve <id> [--note <text>] [--office <id>]
                    approve the story's merge that waits for you: dipo turns
                    GitHub's auto-merge on; past a blocked review the note is
                    required and recorded as your override; exits 1 when
                    nothing waits
  dipo reject <id> --note <text> [--yes] [--office <id>]
                    reject the story's merge that waits for you after asking:
                    your note goes to its worker in a fix round; exits 1 when
                    nothing waits
  dipo test <id> [--office <id>]
                    run the story's pushed head in a new test box and print the
                    URL, the box, the numbered manual steps and the test id
  dipo test pass <id> [--note <text>] [--office <id>]
  dipo test fail <id> --note <text> [--office <id>]
                    record the story's open test: a pass decides its test gate
                    for that head; a fail sends your note to its worker
  dipo test shell <id> [--office <id>]
                    open a shell in the story's test box, for a product with
                    nothing to start
  dipo discard <id> --note <text> [--office <id>]
                    throw a story's work away after listing what is lost and
                    asking for the story id typed out: stop its worker, close
                    its open PR, remove its worktree and delete its branch
                    locally and on the remote, and return it to Refined; for a
                    story Done on the base it removes the leftovers only
  dipo steer <id> <text> [--office <id>]
                    send the story's worker your text as its next message; a
                    parked story gets it with the first message on resume; a
                    reviewer session cannot be steered
  dipo answer <question> --text <answer> [--office <id>]
                    answer a worker's question: a worker waiting on it gets the
                    answer now; a story parked on it resumes with it, and dipo
                    writes that answer to the story as a resolved unknown; put
                    the whole answer in quotes after --text
  dipo desk [--office <id>] [--json]
                    list what waits on you, in the order to handle it: questions
                    a worker waits on, merges, parked stories, hand actions,
                    proposals and the stories you hold, each with the command to
                    type; --json prints the engine's list as it is
  dipo propose accept|dismiss <proposal> [--office <id>]
                    decide a worker's follow-up, spike or tool proposal from
                    dipo desk: accept files it as a Backlog draft through the
                    backlog PR, the worker's words marked as theirs; dismiss
                    closes it and files nothing
  dipo watch [<id>] [--office <id>]
                    follow the office, or one story, in plain text until Ctrl-C:
                    each running story's phase, health, loop, verify, criteria
                    and budget share, then one line per event as it happens
                    (run start and end, phases, worker output, usage and turns,
                    health changes, notices and parks)
  dipo office rescan [--office <id>]
                    scan the office's run profile again and print what changed,
                    its conformance level and each deviation
  dipo office profile [--office <id>] [--json]
                    print the run profile: each capability with its command,
                    source, confidence and whether it is confirmed, pending or
                    stale, the run and test refusals, and each deviation with
                    the standard script that would remove it
  dipo office infer [--office <id>]
                    have a model propose a command for each capability code
                    left unresolved or in conflict; it runs no tool and nothing
                    it proposes runs until you confirm it
  dipo office confirm accept|edit|reject|set|pick|keep <capability> [...]
                    confirm the run profile: accept, edit (-- <command>) or
                    reject a proposal, set a capability by hand (-- <command>,
                    --cwd <dir>), pick a conflict candidate (<n>), or keep a
                    stale confirmation; nothing-to-start [--undo] marks a
                    product with nothing to start
  dipo stats [--office <id>]
                    print the rows and approximate bytes of each table of the
                    office, to tune retention.shortDays and retention.stateDays
  dipo restore <file>
                    replace the state database with a backup from
                    <state>/backups while the daemon is stopped; clients reset
                    and the next start reconciles every office
  dipo login box
                    set or replace the subscription token that boxes reach the
                    model with: paste a token from claude setup-token at the
                    Keychain prompt; dipo never sees it typed and never shows it
  dipo tui [--office <id>] [--no-color] [--ascii] [--inline]
                    open the full-screen client: the office of the current
                    directory (else the first registered one), with o to switch
                    offices and q twice to quit; needs a terminal. NO_COLOR is
                    honoured, --ascii draws only ASCII, --inline keeps the
                    normal scrollback instead of the alternate screen

Office commands use --office, else the office of the current directory.

Commands that need the daemon start it unless daemon.autostart is false in
<state>/config.yaml. Read-only commands never start it: dipo gate, dipo run
--dry-run, dipo stats, dipo desk and dipo watch say when no daemon is running.

Options:
  --version         print the version, commit, Bun version and platform
  --version --json  print the same fields as JSON
  -h, --help        print this help`;

/** `dipo daemon` forms that run daemon-side code; the lifecycle subcommands go through `client`. */
export const DAEMON_FORMS: ReadonlySet<string> = new Set([
  "--foreground",
  "worker-host",
  "wait-pid",
]);

/** The two ways to reach the daemon: only a running one, or one started when none runs. */
export interface ConnectWays<S extends { readonly hello?: { readonly engine: string } | null }> {
  readonly running: () => Promise<S>;
  readonly orStart: () => Promise<{
    readonly session: S;
    readonly started: { readonly pid: number; readonly version: string } | null;
  }>;
}

/**
 * Connects the way `mode` asks: read-only commands (`running`) never start the daemon (DIPO-187);
 * every other command may start it, and says so. Both print the version hint.
 */
export async function connectFor<S extends { readonly hello?: { readonly engine: string } | null }>(
  mode: ConnectMode,
  ways: ConnectWays<S>,
  version: string,
  writeError: (line: string) => void,
): Promise<S> {
  let session: S;
  if (mode === "running") {
    session = await ways.running();
  } else {
    const connected = await ways.orStart();
    session = connected.session;
    if (connected.started !== null) {
      writeError(
        `dipo: started the daemon (pid ${connected.started.pid}, version ${connected.started.version})`,
      );
    }
  }
  const hint = versionHint(version, session.hello?.engine);
  if (hint !== null) writeError(`dipo: ${hint}`);
  return session;
}

export function defaultDeps(): CliDeps {
  const stamp = compiledStamp();
  const runtime = currentRuntime();
  const { version } = versionInfo(stamp, runtime);
  const lifecycle = systemLifecycleDeps({ client: { name: "dipo-cli", version }, origin: "cli" });
  const workspace = systemWorkspace();
  return {
    writeLine: (line) => process.stdout.write(`${line}\n`),
    writeError: (line) => process.stderr.write(`${line}\n`),
    runDaemon: (argv) =>
      runDaemon(argv, {
        version,
        ...(stamp === undefined ? {} : { buildCommit: stamp.commit }),
      }),
    connectDaemon: (mode) =>
      connectFor(
        mode,
        { running: () => connectRunning(lifecycle), orStart: () => connectOrStart(lifecycle) },
        version,
        (line) => process.stderr.write(`${line}\n`),
      ),
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
    workspace,
    tui: systemTui(version, workspace),
    clientChecks: [{ name: INK_SELF_CHECK_NAME, run: checkInk }],
    stamp,
    runtime,
    dirRefusal: () => dirRefusal(process.env),
  };
}

/** Runs the command line and resolves to the process exit code. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = [...argv];
  // Hidden: a worker's command hook (DIPO-59). First, so nothing else runs before it and no flag in
  // its arguments is read as a CLI option.
  if (args[0] === "hook") return deps.runDaemon(args);
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
  // An unusable state or runtime folder override stops every command (DIPO-316); the daemon's own
  // forms above check it themselves.
  const refused = deps.dirRefusal?.() ?? null;
  if (refused !== null) {
    deps.writeError(`dipo: ${refused.message}`);
    return EXIT_CONFIG;
  }
  // The box login in the Keychain (DIPO-269): daemon-side code on this terminal, no daemon needed.
  if (args[0] === "login") return deps.runDaemon(args);
  // Offline maintenance outside the contract (0006 amendment of 2026-10-12): daemon-side code.
  if (args[0] === "restore") {
    const [file, ...rest] = args.slice(1);
    const resolved =
      file === undefined || file.startsWith("-") || rest.length > 0
        ? args.slice(1)
        : [absolute(deps.workspace, file)];
    return deps.runDaemon(["restore", ...resolved]);
  }
  const subcommand = args[0] === "daemon" ? DAEMON_SUBCOMMANDS.get(args[1] ?? "") : undefined;
  if (subcommand !== undefined) {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return subcommand(args.slice(2), { ...deps, version });
  }
  const office =
    args[0] === "office"
      ? (OFFICE_SUBCOMMANDS.get(args[1] ?? "") ?? PROFILE_SUBCOMMANDS.get(args[1] ?? ""))
      : undefined;
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
  if (args[0] === "park") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return parkCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "drop") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return dropCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "approve") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return approveCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "reject") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return rejectCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "test") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return testCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "resume") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return resumeCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "discard") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return discardCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "steer") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return steerCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "answer") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return answerCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "desk") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return deskCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "propose") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return proposeCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "watch") {
    const { version } = versionInfo(deps.stamp, deps.runtime);
    return watchCommand(args.slice(1), { ...deps, version });
  }
  if (args[0] === "tui" && deps.tui !== undefined) {
    return deps.tui(args.slice(1));
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
