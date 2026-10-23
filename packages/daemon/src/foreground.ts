// `dipo daemon --foreground` (0006 decisions 3, 5, 6, 7 and 13): take the PID lock, choose the
// runtime directory, bind the socket and re-read the lock in `starting`; open and migrate the state
// database as the first recovery step in `recovering` (0007 section 1), with `PRAGMA quick_check`
// after an unclean exit (0007 section 10); then `running`, or `safe` after a crash loop. A database
// it cannot open or migrate keeps it in `recovering`, serving software commands with a notice that
// says what to do (0007 sections 9 and 10, DIPO-111). SIGTERM, SIGINT, or the minute check finding
// another live daemon holding the lock, move it to `draining`, and it exits once the drain is done
// or capped. An error no code caught drains it too, and that exit is a crash: exit 1 with the crash
// marker kept (DIPO-117).

import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  EXIT_CONFIG,
  type LogLevel,
  type OfficeId,
  type SoftwareConfig,
  type Spawn,
  type TimerHandle,
} from "@dipsaus-orchestrator/contract";
import {
  AdapterHolds,
  acquireLock,
  BacklogLane,
  BacklogPrs,
  bootoutOwnLaunchdJob,
  boxTokenHoldPath,
  boxTokenStickyHolds,
  CLAUDE_CLI_ADAPTER_ID,
  ChildProcesses,
  chooseRuntimeDir,
  cliRunBase,
  createLogger,
  createSystemIds,
  currentPlatform,
  detachedEnv,
  EngineGit,
  engineFeatures,
  engineRegistry,
  ensurePrivateDir,
  errorCodeOf,
  GateStore,
  GhHost,
  gitStoryPrOps,
  hasLiveClaim,
  helloFeature,
  helloHandshake,
  initKind,
  isLogLevel,
  KeepAwake,
  KeepAwakeHolder,
  lingeringEnabled,
  loadSoftwareConfig,
  LOG_LEVELS,
  MaintenanceScheduler,
  MemoryRequestTable,
  MergeSlot,
  officeFeature,
  activeRunCount,
  OfficeInit,
  officeSummaryOfSource,
  officeSummarySource,
  OfficeManager,
  summarySettings,
  openLogFile,
  openStateDatabase,
  passwdHome,
  readEngineCommitsAfter,
  readRuntimeRecord,
  readWorkActivity,
  removeSocketFile,
  resolveSoftwareDirs,
  resolveTools,
  SoftwareDirError,
  ProposalCommands,
  RunProfiles,
  REATTACH_STEP,
  RUN_TEMP_SWEEP_STEP,
  FIX_ROUNDS_RECOVERY_STEP,
  RECONCILE_STEP,
  Reconciler,
  Retention,
  runtimeCandidates,
  selfCommand,
  serveUnixSocket,
  SOCKET_FILE,
  SlotTable,
  SoftwareStream,
  StoryClaims,
  StoryDiscard,
  StoryIndex,
  StoryPlanning,
  StoryPrs,
  gitParkWriter,
  gitStorySlotOps,
  gitUnparkWriter,
  MergeGates,
  StoryTeardown,
  writeCloseOutSummary,
  systemExecutableStamp,
  systemProcessProbe,
  systemSpawn,
  systemSpawnDetached,
  systemSpawnKeepAwake,
  underLaunchdJob,
  WorkTracker,
  WorkRun,
  writeRuntimeRecord,
  type FeatureModule,
  type ReadExecutableStamp,
  type SpawnDetached,
  type SpawnKeepAwake,
  type HeldLock,
  type Logger,
  type Migration,
  type LogFile,
  type Registry,
  type PidRecord,
  type ProcessProbe,
  type ServedSocket,
  type StoryPlanningDeps,
  type StateDatabase,
  type StoredRun,
  type WorkerPort,
} from "@dipsaus-orchestrator/engine";

import { controlFeature, emitDaemonStates, sumActiveRuns } from "./control";
import { CrashCounter, STABLE_RUN_MS } from "./crash-counter";
import { DEFAULT_DRAIN_CAPS, drain, type DrainCaps, type DrainRequest } from "./drain";
import { EngineBehindCache } from "./engine-behind";
import { noOrphansActive, type DaemonIo, type UncaughtEvent, type UncaughtSource } from "./io";
import { DATABASE_UNAVAILABLE, DaemonLifecycle } from "./lifecycle";
import {
  databaseFailure,
  MIGRATIONS_STEP,
  needsCheckAfter,
  runRecovery,
  RecoverySteps,
  type RecoveryContext,
  type RecoveryStep,
} from "./recovery";
import { backlogCliFor, daemonRuns } from "./runs";
import { ContractServer } from "./server";
import { UPGRADE_REASON, UpgradeWatcher } from "./upgrade";

/** How often the daemon checks that `dipo.pid` still holds its own record (0006 decision 6). */
export const LOCK_CHECK_MS = 60_000;

export const FOREGROUND_USAGE =
  "dipo daemon --foreground [--log-level error|warn|info|debug|trace]";

/**
 * The dependencies of `StoryPlanning` (DIPO-227): the process probe is passed in, so a test can
 * check that the daemon's planning gets the probe it was given.
 */
export function storyPlanningDeps(
  parts: Omit<StoryPlanningDeps, "probe">,
  probe: ProcessProbe,
): StoryPlanningDeps {
  return { ...parts, probe };
}

/** What the daemon is built with; tests add recovery steps and shorten the drain caps. */
export interface ForegroundOptions {
  /** Recovery steps after the migrations, in registration order (DIPO-56, DIPO-57). */
  readonly recoverySteps?: readonly RecoveryStep[];
  /** Replaces the compiled-in migrations; tests add a failing step (DIPO-111). */
  readonly migrations?: readonly Migration[];
  readonly drainCaps?: DrainCaps;
  /** Feature modules served next to the engine's own; tests register fixtures here. */
  readonly features?: readonly FeatureModule[];
  /** How the upgrade check reads the executable; tests replace the file system. */
  readonly readExecutableStamp?: ReadExecutableStamp;
  /** How the daemon starts the new binary after an upgrade drain; tests record the call. */
  readonly spawnDetached?: SpawnDetached;
  /** Starts the keep-awake process (0006 decision 12); tests take no real assertion. */
  readonly spawnKeepAwake?: SpawnKeepAwake;
  /** Runs `launchctl` for the bootout after a refused `config.yaml`; tests record the call. */
  readonly supervisorSpawn?: Spawn;
  /** This process's parent PID, for the launchd bootout check; tests stand in for launchd (1). */
  readonly parentPid?: number;
  /** Wraps the daemon's worker port; a test daemon process plans a scripted worker (DIPO-316). */
  readonly workerPort?: (port: WorkerPort) => WorkerPort;
}

/** The drain reason after an error no code caught (DIPO-117). */
export const UNCAUGHT_REASON = "uncaught error";

const UNCAUGHT_MESSAGES: Readonly<Record<UncaughtEvent, string>> = {
  unhandledRejection: "an unhandled rejection reached the daemon",
  uncaughtException: "an uncaught exception reached the daemon",
};

/**
 * Logs each error no code caught once, with its error code when it has one (DIPO-110), then calls
 * `onError` (DIPO-117). The listener never throws: an error thrown again from it would leave Bun
 * 1.4.2 under the binary's top-level await reporting it and running on in an unknown state (a
 * rejection), or exiting 7 at once without a drain (an exception). Known engine jobs never get here:
 * `background` catches and logs their failures. Returns the remover.
 */
export function onUncaughtErrors(
  logger: Logger,
  onError: (event: UncaughtEvent) => void,
  source: UncaughtSource = process,
): () => void {
  const listeners = (Object.keys(UNCAUGHT_MESSAGES) as UncaughtEvent[]).map((event) => {
    const listener = (error: unknown): void => {
      try {
        const code = errorCodeOf(error);
        logger.error(UNCAUGHT_MESSAGES[event], {
          error,
          ...(code === undefined ? {} : { errorCode: code }),
        });
      } catch {
        // A failing log must not stop the drain.
      }
      try {
        onError(event);
      } catch {
        // Nothing may throw from here; see above.
      }
    };
    source.on(event, listener);
    return { event, listener };
  });
  return () => {
    for (const { event, listener } of listeners) source.off(event, listener);
  };
}

/**
 * The first stop request wins: a signal, a lost lock, later `daemon.stop` (DIPO-24), or an error no
 * code caught (DIPO-117).
 */
class StopRequests {
  #requested: DrainRequest | null = null;
  #crashed = false;
  #resolve: (request: DrainRequest) => void = () => {};
  readonly promise = new Promise<DrainRequest>((resolve) => {
    this.#resolve = resolve;
  });

  get requested(): DrainRequest | null {
    return this.#requested;
  }

  /** True once an error no code caught reached the daemon: its exit is a crash. */
  get crashed(): boolean {
    return this.#crashed;
  }

  request(request: DrainRequest): void {
    if (this.#requested !== null) return;
    this.#requested = request;
    this.#resolve(request);
  }

  /**
   * An error no code caught (DIPO-117): drains with its own reason, unless a drain is already
   * requested (a signal, `daemon.stop`, an earlier error), and makes the exit a crash either way.
   */
  crash(): void {
    this.#crashed = true;
    this.request({ reason: UNCAUGHT_REASON, stopWorkers: false });
  }
}

function parseLevel(
  args: readonly string[],
  env: DaemonIo["env"],
): { level: LogLevel } | { error: string } {
  let values: { "log-level"?: string | undefined };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { "log-level": { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const level = values["log-level"] ?? env["DIPO_LOG"] ?? "info";
  if (!isLogLevel(level)) {
    return { error: `unknown log level ${JSON.stringify(level)}; use ${LOG_LEVELS.join(", ")}` };
  }
  return { level };
}

/** Runs the daemon in this process; resolves to the exit code. `args` follow `--foreground`. */
export async function runForeground(
  args: readonly string[],
  io: DaemonIo,
  options: ForegroundOptions = {},
): Promise<number> {
  if (noOrphansActive(io)) {
    io.writeError(
      "dipo: refusing to start the daemon with --no-orphans (in the Bun flags or BUN_OPTIONS): it would stop the daemon with its parent and kill every worker on exit. Remove it from BUN_OPTIONS and start again.",
    );
    return 1;
  }
  const parsed = parseLevel(args, io.env);
  if ("error" in parsed) {
    io.writeError(`dipo: ${parsed.error}\nusage: ${FOREGROUND_USAGE}`);
    return 2;
  }

  // Listen for SIGTERM and SIGINT from the start, so a signal during startup still drains.
  const stops = new StopRequests();
  const removeSignal = io.onShutdownSignal((signal) =>
    stops.request({ reason: signal, stopWorkers: false }),
  );

  const platform = currentPlatform();
  let dirs: ReturnType<typeof resolveSoftwareDirs>;
  try {
    dirs = resolveSoftwareDirs({ platform, env: io.env, home: passwdHome() });
  } catch (error) {
    // A `DIPO_HOME` dipo cannot use, or the real state folder in a test, stops the start before
    // anything is written (DIPO-316); like an invalid configuration, a restart would not help.
    if (!(error instanceof SoftwareDirError)) throw error;
    removeSignal();
    io.writeError(`dipo: ${error.message}`);
    return EXIT_CONFIG;
  }
  ensurePrivateDir(dirs.state);
  const logFile = openLogFile(dirs.logs);
  const logger = createLogger({
    clock: io.clock,
    sinks: [logFile.sink, (line) => io.writeError(line)],
    level: parsed.level,
    component: "daemon",
  });
  // An error no code caught (DIPO-117) drains the daemon and makes its exit a crash: the crash
  // marker stays and the exit code is 1, so the crash loop counts it (0006 decision 7).
  const removeUncaught = onUncaughtErrors(logger, () => stops.crash(), io.uncaughtErrors);
  try {
    // Software-level settings (0006 amendment of 2026-10-12), read once at start. An invalid or
    // newer file stops the start: the daemon never guesses its own settings (0017 section 5). It
    // exits with EXIT_CONFIG (78), so a supervisor does not restart it in a loop (DIPO-63).
    const settings = await loadSoftwareConfig(dirs.state);
    if (!settings.ok) {
      for (const error of settings.errors) {
        logger.error("invalid software configuration", { ...error });
        io.writeError(`dipo: ${error.message}`);
      }
      // Under launchd, exit 78 alone would be restarted (KeepAlive.SuccessfulExit = false): the
      // daemon boots its own job out first, so the refusal is not a restart loop (DIPO-63). The
      // systemd unit stops on 78 by itself (RestartPreventExitStatus=78).
      if (underLaunchdJob(io.env)) {
        const target = await bootoutOwnLaunchdJob({
          spawn: options.supervisorSpawn ?? systemSpawn,
          uid: process.getuid?.() ?? -1,
          pid: process.pid,
          ppid: options.parentPid ?? process.ppid,
          clock: io.clock,
        });
        if (target !== null) {
          logger.error(
            "booted the launchd job out so it is not restarted with this configuration",
            {
              target,
            },
          );
        }
      }
      return EXIT_CONFIG;
    }
    logger.info("software configuration", {
      fromFile: settings.fromFile,
      ...settings.config.daemon,
    });
    const code = await runWithLog({
      io,
      logger,
      logFile,
      settings: settings.config,
      stateDir: dirs.state,
      platform,
      homeMismatch: dirs.homeMismatch,
      stops,
      options,
    });
    // Only an error no code caught in this process turns an exit 0 into 1 (DIPO-117): one that came
    // while the daemon closed down after its drain, or one in a start that then found another daemon
    // running. Without such an error, that start still exits 0, so a supervisor does not restart it.
    return code === 0 && stops.crashed ? 1 : code;
  } catch (error) {
    logger.error("daemon failed", { error });
    io.writeError(`dipo: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    removeSignal();
    removeUncaught();
    logFile.close();
  }
}

interface Run {
  readonly io: DaemonIo;
  readonly logger: Logger;
  readonly logFile: LogFile;
  /** The software-level settings read at start; DIPO-70 acts on `daemon.autoRestartOnUpgrade`. */
  readonly settings: SoftwareConfig;
  readonly stateDir: string;
  readonly platform: ReturnType<typeof currentPlatform>;
  readonly homeMismatch: { readonly env: string; readonly passwd: string } | null;
  readonly stops: StopRequests;
  readonly options: ForegroundOptions;
}

async function runWithLog(run: Run): Promise<number> {
  const { io, logger, stateDir, platform, homeMismatch } = run;
  if (homeMismatch !== null) {
    logger.warn("$HOME differs from the passwd home directory; dipo uses the passwd home", {
      home: homeMismatch.env,
      passwdHome: homeMismatch.passwd,
    });
  }
  const probe = systemProcessProbe(platform);
  const own = await probe(process.pid);
  if (own === null) throw new Error(`cannot read this process's start time (pid ${process.pid})`);
  const self: PidRecord = {
    pid: process.pid,
    startTimeMs: own.startTimeMs,
    version: io.version,
    runtimeDir: null,
  };
  logger.info("daemon starting", { pid: self.pid, version: self.version, state: stateDir });

  const outcome = await acquireLock({
    stateDir,
    self,
    probe,
    clock: io.clock,
    logger,
    // Step 1 asks the running daemon itself: engine.hello, then daemon.status over ws+unix://.
    handshake: helloHandshake({
      stateDir,
      clock: io.clock,
      client: { name: "dipo daemon", version: io.version },
    }),
  });
  if (outcome.kind === "running") {
    const runtime = await readRuntimeRecord(stateDir);
    logger.info("another daemon is running", { pid: outcome.record.pid });
    io.writeLine(
      `dipo daemon is already running (pid ${outcome.record.pid}, version ${outcome.record.version}${runtime === null ? "" : `, socket ${runtime.socket}`})`,
    );
    return 0;
  }
  if (outcome.kind === "unresponsive") {
    logger.error("a daemon holds the lock but does not answer", { pid: outcome.record.pid });
    io.writeError(
      `dipo: the daemon (pid ${outcome.record.pid}) holds the lock but does not answer. Run \`dipo daemon stop --force\` to stop it.`,
    );
    return 1;
  }
  return serve(run, outcome.lock);
}

async function serve(run: Run, lock: HeldLock): Promise<number> {
  const { io, logger, logFile, stateDir, platform, stops, options } = run;
  const clock = io.clock;
  const startedAt = clock.now();
  const lifecycle = new DaemonLifecycle("daemon started");
  lifecycle.onTransition((change) => logger.info("daemon state", { ...change }));
  // The software stream: a ring buffer with a new random epoch at every start (0006 decision 9).
  const software = new SoftwareStream({ clock });
  emitDaemonStates(lifecycle, software);
  const children = new ChildProcesses();
  const held: {
    socket: ServedSocket | null;
    database: StateDatabase | null;
    crashes: CrashCounter | null;
    lockTimer: TimerHandle | null;
    stableTimer: TimerHandle | null;
    storyIndex: StoryIndex | null;
    teardown: StoryTeardown | null;
    storyPrs: StoryPrs | null;
    mergeSlot: MergeSlot | null;
    retention: Retention | null;
    maintenance: MaintenanceScheduler | null;
    ingest: { close(): void } | null;
    /** The box workers (DIPO-271): every running box is stopped at daemon stop. */
    boxes: { close(): Promise<void> } | null;
    /** The collision check of the box runs (DIPO-277): its poll stops at daemon stop. */
    collisions: { stop(): void } | null;
    engineBehind: EngineBehindCache | null;
    contract: ContractServer | null;
  } = {
    socket: null,
    database: null,
    crashes: null,
    lockTimer: null,
    stableTimer: null,
    storyIndex: null,
    teardown: null,
    storyPrs: null,
    mergeSlot: null,
    retention: null,
    maintenance: null,
    ingest: null,
    boxes: null,
    collisions: null,
    engineBehind: null,
    contract: null,
  };
  let lockLost = false;
  let clean = false;
  let upgrade: UpgradeWatcher | null = null;
  // Keep-awake (0006 decision 12): one assertion for every office while work is active, read from
  // the state database once recovery opened it.
  const work = new WorkTracker();
  const keepAwake = new KeepAwake({
    platform,
    holder: new KeepAwakeHolder({
      platform,
      daemonPid: process.pid,
      dipoCommand: selfCommand(),
      env: detachedEnv(io.env),
      spawn: options.spawnKeepAwake ?? systemSpawnKeepAwake,
      clock,
      logger: logger.child({ component: "keep-awake" }),
    }),
    read: () => {
      const database = held.database;
      if (database === null) throw new Error("the state database is not open");
      return readWorkActivity(database.connection, systemProcessProbe(platform), work, clock.now());
    },
    clock,
    logger: logger.child({ component: "keep-awake" }),
  });
  try {
    logger.info("daemon state", { to: lifecycle.state, reason: lifecycle.reason });
    // The crash counter (0006 decision 7), opened right after the lock is taken so an unclean exit
    // anywhere later, also early in `starting`, counts as a crash: a marker left by the previous
    // daemon is one crash.
    const opened = CrashCounter.open(stateDir, lock.record(), clock);
    const crashes = opened.counter;
    held.crashes = crashes;
    if (opened.damaged) logger.warn("the crash counter was unreadable; starting it afresh");
    if (opened.previousCrashed) {
      logger.warn("the previous daemon did not exit cleanly", {
        recentCrashes: crashes.recentCrashes,
      });
    }
    const uid = process.getuid?.() ?? -1;
    const tmpBase = io.env["DIPO_TMP"] || "/tmp";
    const choice = chooseRuntimeDir({
      candidates: runtimeCandidates({
        platform,
        env: io.env,
        uid,
        lingering: platform === "linux" && lingeringEnabled(),
      }),
      uid,
      tmpBase,
      env: io.env,
    });
    for (const rejected of choice.rejected) {
      logger.warn("runtime directory candidate rejected", { ...rejected });
    }
    logger.info("runtime directory chosen", { path: choice.path, source: choice.source });
    lock.setRuntimeDir(choice.path);

    const socketPath = join(choice.path, SOCKET_FILE);
    removeSocketFile(socketPath);
    const record = lock.record();

    // Tool paths from this daemon's PATH, which the starting client kept (DIPO-70). A missing tool
    // is reported, never a reason to stop the start.
    const tools = resolveTools(io.env["PATH"]);
    logger.info("tools resolved", { ...tools.paths, missing: tools.missing });
    for (const tool of tools.missing) logger.warn("tool not found on PATH", { tool });
    // Every Backlog CLI call of this daemon runs the `backlog` it resolved (DIPO-74).
    const backlogCli = backlogCliFor(tools.paths);
    // The machine-wide port slot table (DIPO-39): setup takes a slot, teardown and a rolled-back
    // setup free it.
    const slots = SlotTable.inState(stateDir);

    // Upgrades (0006 decision 14): checked every minute; an engine step is a child the daemon
    // started or a command still writing, and an automatic restart waits for both. Once any stop
    // is requested (`daemon.stop`, a signal, a restart, a lost lock) the watcher counts as busy
    // and stops, so a daemon someone stopped never starts a new binary on its own.
    const command = selfCommand();
    upgrade = new UpgradeWatcher({
      clock,
      logger,
      executable: command[command.length - 1] ?? process.execPath,
      readStamp: options.readExecutableStamp ?? systemExecutableStamp,
      autoRestart: run.settings.daemon.autoRestartOnUpgrade,
      busy: () => stops.requested !== null || children.size > 0 || lifecycle.inFlight > 0,
      restart: () => stops.request({ reason: UPGRADE_REASON, stopWorkers: false }),
    });
    const watcher = upgrade;
    void stops.promise.then(() => watcher.stop());
    // Office commands reach the database only once the migrations step opened it; until then the
    // lifecycle gate answers them with engine.recovering. Office engine instances load lazily on
    // first use (0006 decision 4, DIPO-27).
    const ids = createSystemIds(clock);
    let server: ContractServer | null = null;
    const offices = new OfficeManager({
      database: () => held.database,
      registry: () => registry,
      software,
      clock,
      ids,
      git: {
        spawn: systemSpawn,
        ...(tools.paths.git === undefined ? {} : { git: tools.paths.git }),
      },
      logger: logger.child({ component: "office" }),
      onOfficeChanged: (office) => server?.notifyOffice(office),
    });
    // The engine's git (DIPO-31): one serial queue per loaded office, with the git this daemon
    // resolved from its PATH, so every office uses the same binary.
    const engineGit = new EngineGit({
      spawn: systemSpawn,
      ...(tools.paths.git === undefined ? {} : { git: tools.paths.git }),
    });
    // The engine commits each office base has after the build commit (DIPO-198), read in the
    // background so `daemon.status` answers from memory.
    const buildCommit = io.buildCommit;
    const engineBehind =
      buildCommit === undefined
        ? null
        : new EngineBehindCache({
            clock,
            logger: logger.child({ component: "engine-behind" }),
            loadedOffices: () => offices.loadedOffices(),
            source: (office) => {
              const officeGit = engineGit.forOffice(office);
              if (officeGit === undefined) return undefined;
              return {
                mainWorktree: officeGit.mainWorktree,
                read: () => readEngineCommitsAfter(officeGit, buildCommit),
              };
            },
          });
    held.engineBehind = engineBehind;
    // The planning lane (DIPO-34): its replay load step needs the office git, so it follows
    // engineGit.feature. The `backlog` on the daemon PATH, as for the version check.
    // Story claims (DIPO-38): their load step pins live claims' worktree snapshots on the office
    // git, so it follows engineGit.feature. The lane refuses a story with a live claim.
    const claims = new StoryClaims({
      cli: backlogCli,
      git: (office) => engineGit.forOffice(office),
      slots,
      warn: (message, fields) => logger.warn(message, { component: "claims", ...fields }),
      info: (message, fields) => logger.info(message, { component: "claims", ...fields }),
      // Leftover `_branch-read-*` scratch directories older than this start are swept (DIPO-90).
      startedAt,
      onChanged: (office) => server?.notifyOffice(office),
    });
    // Done detection and teardown (DIPO-58): every `polling.prStateSeconds` the merged PR of each
    // finished claim is looked up through `gh` on this daemon's PATH (else `git merge-tree`
    // decides); a Done story's worktree and branches are removed and its slot freed. Its load step
    // follows claims.feature.
    // One `gh` host, on this daemon's PATH, for teardown, the backlog PR and the merge slot.
    const host = new GhHost({
      spawn: systemSpawn,
      ...(tools.paths.gh === undefined ? {} : { gh: tools.paths.gh }),
      env: io.env,
      logger: logger.child({ component: "gh" }),
    });
    const teardown = new StoryTeardown({
      git: (office) => engineGit.forOffice(office),
      host,
      // A story Done on the base through another branch has its open story PR closed and the box
      // of its ended run deleted (DIPO-161); the runs are made below and called only by a poll.
      prCloser: host,
      finishBoxes: () => runs.finishEndedBoxes(),
      cli: backlogCli,
      offices,
      slots,
      onChanged: (office) => server?.notifyOffice(office),
      logger: logger.child({ component: "teardown" }),
    });
    held.teardown = teardown;
    // The story PR (DIPO-144): opened or updated right after each In Review push, and retried
    // every `polling.prStateSeconds` until it exists, through the same `gh` host. Whether a run
    // is a box run comes from the runs made below (DIPO-299: CI is the verify of a box run).
    let boxRunOf: ((office: OfficeId, stored: StoredRun) => boolean) | null = null;
    const storyPrs = new StoryPrs({
      host,
      git: gitStoryPrOps({ git: (office) => engineGit.forOffice(office), cli: backlogCli }),
      offices,
      clock,
      onChanged: (office) => server?.notifyOffice(office),
      logger: logger.child({ component: "story-pr" }),
      // CI on the story PR (DIPO-147): the checks and job logs of a red head, and the park at the
      // run's CI cap. The registry is built below; a park is only written after it exists.
      review: host,
      park: {
        writer: gitParkWriter({ git: (office) => engineGit.forOffice(office), cli: backlogCli }),
        implemented: (name) => registry.command(name) !== undefined,
      },
      boxRun: (office, stored) => boxRunOf?.(office, stored) === true,
      // The merge slot below merges story PRs (DIPO-150).
      mergesStories: true,
    });
    held.storyPrs = storyPrs;
    // The backlog PR (DIPO-35): opened or updated after each lane flush through `gh` on this
    // daemon's PATH, and looked up after each story-index poll for a merge by hand.
    const backlogPrs: BacklogPrs = new BacklogPrs({
      host,
      // Reconcile lists the open `dipo/backlog-*` PRs to adopt one after a lost database (DIPO-80).
      list: host,
      lane: (office) => lane.forOffice(office),
      cli: backlogCli,
      offices,
      clock,
      onChanged: (office) => server?.notifyOffice(office),
    });
    const lane: BacklogLane = new BacklogLane({
      cli: backlogCli,
      git: (office) => engineGit.forOffice(office),
      // Office init's steps (DIPO-36) are lane operations of their own kind.
      kinds: [initKind()],
      liveClaim: hasLiveClaim,
      onChanged: (office) => server?.notifyOffice(office),
      onFlushed: async (office, report) => {
        await backlogPrs.afterFlush(office, report);
        mergeSlot.kick(office);
      },
      held: (office) => mergeSlot.holding(office),
    });
    // Office init (DIPO-36): `office.init` reads the base and submits its steps to the lane, whose
    // flush opens the backlog PR and kicks the merge slot. Its load step, which raises a notice
    // while the base lacks the statuses runs need, follows the story index's fetch.
    const officeInit = new OfficeInit({
      offices,
      lane: (office) => lane.forOffice(office),
      git: (office) => engineGit.forOffice(office),
      cli: backlogCli,
      clock,
      prWaiting: (office) => backlogPrs.waiting(office),
      onChanged: (office) => server?.notifyOffice(office),
    });
    // The merge slot (DIPO-73, DIPO-150): merges the office's backlog PR once `ci-ok`, `pr-title`
    // and the structural check pass, and each story PR whose merge gate was approved after its
    // review and required checks, one PR at a time, polling every `polling.prStateSeconds`; it
    // holds new lane operations while a backlog PR is in it. Its occupant is in the state database.
    // The run services are made below; the slot reaches them only from a tick, after load.
    const storySlotGit = gitStorySlotOps({
      git: (office) => engineGit.forOffice(office),
      cli: backlogCli,
    });
    const mergeSlot: MergeSlot = new MergeSlot({
      host,
      prs: backlogPrs,
      lane: (office) => lane.forOffice(office),
      offices,
      clock,
      labels: host,
      stories: {
        git: storySlotGit,
        ids,
        labels: host,
        ci: (office, runId) => storyPrs.ciState(office, runId),
        prSync: (office, runId) => storyPrs.sync(office, runId),
        story: (office, stored) => runs.mergeSlot.story(office, stored),
        summary: writeCloseOutSummary,
        recordMerge: (office, stored, merged) => runs.mergeSlot.recordMerge(office, stored, merged),
        conflict: (office, runId, input) => runs.mergeSlot.conflict(office, runId, input),
        park: {
          writer: gitParkWriter({ git: (office) => engineGit.forOffice(office), cli: backlogCli }),
          implemented: (name) => registry.command(name) !== undefined,
        },
        itemMax: (office, stored) => runs.mergeSlot.itemMax(office, stored),
      },
      onChanged: (office) => server?.notifyOffice(office),
      logger: logger.child({ component: "merge-slot" }),
    });
    held.mergeSlot = mergeSlot;
    // `gate.approve` and `gate.reject` on merge gates (DIPO-150 with DIPO-151): a decision kicks
    // the slot, a reject's note goes to the worker in a fix round.
    const mergeGates = new MergeGates({
      labels: host,
      unpark: gitUnparkWriter({ git: (office) => engineGit.forOffice(office), cli: backlogCli }),
      reject: (office, runId, reject) => runs.mergeSlot.reject(office, runId, reject),
      kick: (office) => mergeSlot.kick(office),
      prSync: (office, runId) => storyPrs.sync(office, runId),
      refreshStory: (office, key) => storyIndex.refreshStory(office, key, { quiet: true }),
      // A decision only for the head the gate holds for; the park put back when an override is not
      // recorded after its lift.
      holds: (office, gate, head) => mergeSlot.gateHolds(office, gate, head),
      repark: gitParkWriter({ git: (office) => engineGit.forOffice(office), cli: backlogCli }),
    });
    // `story.hold`, `story.drop` and the on-hold resume of `work.resume` (DIPO-160): lane
    // operations, the story PR closed through the same `gh` host and the claim released with the
    // office git.
    const planning = new StoryPlanning(
      storyPlanningDeps(
        {
          lane: (office) => lane.forOffice(office),
          git: (office) => engineGit.forOffice(office),
          host,
          slots,
          implemented: (name) => registry.command(name) !== undefined,
        },
        systemProcessProbe(platform),
      ),
    );
    // `work.discard` (DIPO-161): a running story is stopped as `work.stop` does, the story PR
    // closed through the same `gh` host, the claim released with the office git, a Refined write
    // through the lane, and the box of the ended run deleted (0021 section 6). The run control is
    // made below and only called once a command runs.
    const discard = new StoryDiscard({
      lane: (office) => lane.forOffice(office),
      git: (office) => engineGit.forOffice(office),
      host,
      slots,
      probe: systemProcessProbe(platform),
      stop: (ctx, args) => runs.control.stop(ctx, args),
      finishBoxes: () => runs.finishEndedBoxes(),
      // A story the `backlog` on this PATH reads Done in `_base` gets no Refined write.
      cli: backlogCli,
    });
    // `proposal.accept` and `proposal.dismiss` (DIPO-166): an accepted worker proposal becomes a
    // Backlog draft through the planning lane.
    const proposals = new ProposalCommands({ lane: (office) => lane.forOffice(office) });
    // The story index (DIPO-32): indexes each office at load, after the git load step and the
    // lane's replay, and polls its remote every `polling.fetchSeconds`, with the `backlog` this
    // daemon found on its PATH.
    const storyIndex = new StoryIndex({
      git: engineGit,
      cli: backlogCli,
      offices,
      onOfficeChanged: (office) => server?.notifyOffice(office),
      onPolled: (office) => {
        void backlogPrs.sync(office).catch((error: unknown) => {
          logger.warn("checking the backlog PR failed", {
            office,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      },
      // A change of `.dipo/office.yaml` that reached the base is in force from this poll (DIPO-303).
      reloadConfig: (office) => offices.reloadIfChanged(office, engineGit.forOffice(office)),
      logger: logger.child({ component: "stories" }),
    });
    held.storyIndex = storyIndex;
    // The Ready gate (DIPO-71): the read `story.gate` and stored decisions, read on `_base` with
    // the office git and the `backlog` this daemon found on its PATH.
    const gates = new GateStore({
      git: engineGit,
      cli: backlogCli,
      offices,
      clock,
      ids,
      index: storyIndex,
    });
    // The run profile (DIPO-72): scanned at load after the story index fetched, and on
    // `office.rescan`, which also indexes the stories again.
    const runProfiles = new RunProfiles({
      git: engineGit,
      stories: storyIndex,
      reconcile: (office) => reconciler.reconcile(office),
      reloadConfig: (office) => offices.reloadIfChanged(office, engineGit.forOffice(office)),
      onOfficeChanged: (office) => server?.notifyOffice(office),
      logger: logger.child({ component: "scan" }),
    });
    // Adapter holds (DIPO-43): a failed launch check holds new runs on that adapter in every
    // office, with a notice on the software stream. `work.run` refuses while its adapter is held;
    // the run launcher below runs the launch checks that set and lift a hold.
    // The box-token hold (DIPO-271) is sticky: kept in the state directory over a restart, and
    // lifted only when `dipo login box` replaces the token and removes its record.
    const holds = new AdapterHolds({
      clock,
      notify: (notice) => software.append("engine.notice", notice),
      sticky: boxTokenStickyHolds(boxTokenHoldPath(stateDir), CLAUDE_CLI_ADAPTER_ID),
      warn: (message, fields) => logger.warn(message, fields),
    });
    const runBase = cliRunBase({
      git: (office) => engineGit.forOffice(office),
      cli: backlogCli,
    });
    // The worker start of a claimed run (DIPO-74): setup, prompts, launch checks, the worker
    // host and ingestion, with the `claude` this daemon resolved on its PATH.
    const runs = daemonRuns({
      tools: tools.paths,
      platform,
      clock,
      ids,
      env: io.env,
      home: passwdHome(),
      uid,
      runtimeDir: choice.path,
      tmpRoot: tmpBase,
      stateDir,
      holds,
      engineGit,
      claims,
      offices,
      slots,
      base: runBase,
      database: () => held.database,
      onChanged: (office) => server?.notifyOffice(office),
      logger: logger.child({ component: "runs" }),
      cli: backlogCli,
      storyPr: storyPrs,
      holdResumer: () => planning,
      // A resumed slot-refused park re-enters the merge slot (DIPO-150, DIPO-155's seam).
      slotReentry: () => mergeSlot,
      ...(options.workerPort === undefined ? {} : { workerPort: options.workerPort }),
      stories: storyIndex,
      // The registry is built below; parks are only written after it exists.
      implemented: (name) => registry.command(name) !== undefined,
      // A question is live only while a TUI is connected at that moment (0021 section 11,
      // DIPO-279); the server is made below.
      presence: { tuiConnected: () => server?.presence.tuiConnected() ?? false },
      // Plan limits (DIPO-61): a warning's notice goes to the software stream, and a held run
      // resumes only while the daemon schedules work.
      notify: (notice) => software.append("engine.notice", notice),
      scheduling: () => lifecycle.state === "running",
    });
    // Reconcile (DIPO-56, 0007 section 6): the last office load step, so every office the daemon
    // loads in `recovering` (below) is reconciled before scheduling turns on; `office.rescan` runs
    // it again. It stops and parks runs through the run control and releases orphaned claims.
    const reconciler = new Reconciler({
      git: (office) => engineGit.forOffice(office),
      stories: storyIndex,
      runs: runs.control,
      releaseClaim: (office, claim, reason) => claims.releaseUnstarted(office, claim, reason),
      slots,
      // A story Done on the base through another branch has its open story PR closed and the box
      // of its ended run deleted (DIPO-161).
      host,
      finishBoxes: () => runs.finishEndedBoxes(),
      adoptBacklogPr: (office) => backlogPrs.adopt(office),
      refuse: (office, text) => offices.refuse(office, text),
      onOfficeChanged: (office) => server?.notifyOffice(office),
      logger: logger.child({ component: "reconcile" }),
    });
    // Ingestion, the cap ticks of run control (DIPO-50), the plan-limit timers (DIPO-61) and the
    // places' tick (DIPO-142) stop together.
    held.ingest = {
      close: () => {
        runs.planLimits.close();
        runs.places.close();
        runs.control.close();
        runs.permissions.close();
        runs.ingest.close();
        runs.reattacher.close();
        runs.stopBoxPasses();
      },
    };
    // Daemon stop ends every box worker inside its box, and its routes (DIPO-271).
    held.boxes = runs.boxes;
    boxRunOf = (office, stored) => runs.isBoxRun(office, stored);
    held.collisions = runs.collisions;
    // `work.run` (DIPO-48): picks and claims one Ready story and records the run, through the
    // story index, the run profile, office init's statuses check, the claims, the Ready gate and
    // the planning lane above.
    const workRun = new WorkRun({
      offices,
      base: runBase,
      stories: storyIndex,
      profiles: runProfiles,
      statuses: (office) => officeInit.officeStatusesReady(office),
      adapterHeld: (adapter) => holds.adapterHeld(adapter),
      planLimitHeld: (adapter, model) => runs.planLimits.held(adapter, model),
      claims,
      gates,
      lane: (office) => lane.forOffice(office),
      launcher: runs.launcher,
      liveSlots: () => slots.live(),
      // The worker place is decided and taken in the places' serialized steps (DIPO-208).
      places: runs.places,
    });
    // Retention (DIPO-65): a load step runs it when an office loads, then hourly while it stays
    // loaded, with the `retention.*` periods of the configuration in force.
    const retention = new Retention({
      offices,
      onOfficeChanged: (office) => server?.notifyOffice(office),
      logger: logger.child({ component: "retention" }),
    });
    held.retention = retention;
    // Office summaries for `engine.hello` and the software stream, from the office rows (DIPO-32).
    // `optIns` names the privacy opt-ins that are on (0007 section 8, DIPO-83) and
    // `outputRetentionDays` the stored-output retention period (0007 section 7, DIPO-97).
    const settingsOf = (office: OfficeId) =>
      summarySettings(offices.config(office), offices.localOverrideKeys(office));
    const summaries = officeSummarySource(() => held.database, settingsOf);
    const registry: Registry = engineRegistry([
      ...engineFeatures({ backlog: backlogCli }),
      engineGit.feature,
      claims.feature,
      teardown.feature,
      storyPrs.feature,
      lane.feature,
      storyIndex.feature,
      mergeSlot.feature,
      officeInit.feature,
      gates.feature,
      runProfiles.feature,
      workRun.feature,
      planning.feature,
      mergeGates.feature,
      discard.feature,
      proposals.feature,
      runs.control.feature,
      runs.outcomes.feature,
      runs.permissions.feature,
      runs.planLimits.feature,
      // After the outcomes' load step: what waited for a place starts once exits are decided.
      runs.places.feature,
      retention.feature,
      reconciler.feature,
      officeFeature(offices),
      // The summary names the privacy opt-ins that are on (DIPO-83): an office load or a reloaded
      // configuration may change them, so the summary is sent again (debounced, only when changed).
      {
        name: "privacy.summary",
        register: (features) => {
          features.registerLoadStep("privacy.summary", (ctx) => {
            server?.notifyOffice(ctx.officeId);
          });
          features.registerConfigReload("privacy.summary", (ctx) => {
            server?.notifyOffice(ctx.officeId);
          });
        },
      },
      helloFeature({
        engineVersion: io.version,
        daemonState: () => lifecycle.state,
        softwareCursor: () => software.head(),
        officeSummaries: summaries,
      }),
      controlFeature({
        lifecycle,
        logger,
        clock,
        startedAt,
        pid: record.pid,
        version: io.version,
        ...(io.buildCommit === undefined
          ? {}
          : {
              buildCommit: io.buildCommit,
              engineBehind: () => engineBehind?.rows() ?? [],
            }),
        socket: socketPath,
        tools: tools.paths,
        upgradePending: () => watcher.pending,
        keepAwake: () => keepAwake.status(),
        loadedOffices: () => offices.loadedOffices(),
        activeRuns: () =>
          sumActiveRuns(offices.loadedOffices(), (office) => {
            const handle = offices.get(office);
            return handle === undefined ? undefined : activeRunCount(handle);
          }),
        requestStop: (request) => stops.request(request),
      }),
      ...(options.features ?? []),
    ]);
    const contract = new ContractServer({
      registry,
      offices,
      clock,
      ids,
      softwareRequests: new MemoryRequestTable(clock),
      lifecycle,
      software,
      officeSummaries: summaries,
      officeSummary: officeSummaryOfSource(() => held.database, settingsOf),
      engineVersion: io.version,
      logger: logger.child({ component: "server" }),
    });
    server = contract;
    // The last TUI closing ends every live question at once, so its story parks with it (0021
    // section 11, DIPO-284).
    contract.onPresenceChanged(() => runs.permissions.presenceChanged());
    held.contract = contract;
    held.socket = serveUnixSocket(socketPath, (connection) => contract.accept(connection));

    // The stale-break window (0006 decision 6): re-read the lock after binding and before
    // touching any state. The database stays closed when the lock is not ours (0007 section 1).
    if (!lock.verify()) {
      logger.error("the daemon lock does not hold this process after binding; exiting", {
        path: lock.path,
      });
      io.writeError("dipo: another daemon took the lock while this one started; exiting.");
      return 1;
    }
    writeRuntimeRecord(stateDir, {
      runtimeDir: choice.path,
      socket: socketPath,
      pid: record.pid,
      startTimeMs: record.startTimeMs,
      version: record.version,
    });
    logger.info("listening", { socket: socketPath });

    const tick = () => {
      held.lockTimer = clock.setTimeout(() => {
        held.lockTimer = null;
        lock.check().then(
          (result) => {
            if (result.kind === "lost") {
              logger.error("another live daemon holds the lock; draining", {
                holder: result.holder.pid,
              });
              lockLost = true;
              stops.request({ reason: "lock lost", stopWorkers: false });
              return;
            }
            if (stops.requested === null) tick();
          },
          (error: unknown) => {
            logger.error("lock check failed", { error });
            if (stops.requested === null) tick();
          },
        );
      }, LOCK_CHECK_MS);
    };
    tick();
    watcher.start();

    // After an unclean exit the file may be damaged (0007 section 10): `PRAGMA quick_check` at open.
    // An unreadable crash counter cannot tell, so it counts as one, and so does a check an earlier
    // daemon left pending (`needsCheck`, DIPO-111). A database that cannot be opened, checked or
    // migrated holds the daemon in `recovering` (DIPO-111): office commands and reads get
    // `database.unavailable`, the notice and `daemon.status` say what to do, and the daemon stays
    // up, so a supervisor does not restart it in a loop.
    const checkBecause = opened.previousCrashed
      ? "unclean exit"
      : opened.damaged
        ? "crash counter unreadable"
        : opened.needsCheck
          ? "check pending from an earlier start"
          : null;
    const checkIntegrity = checkBecause !== null;
    const steps = new RecoverySteps({
      name: MIGRATIONS_STEP,
      run: async (context) => {
        const dbLogger = context.logger.child({ component: "database" });
        if (checkBecause !== null) {
          dbLogger.info("checking the state database with quick_check", { because: checkBecause });
        }
        try {
          held.database = await openStateDatabase({
            stateDir,
            logger: dbLogger,
            clock,
            engineVersion: io.version,
            checkIntegrity,
            ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
          });
          // The check passed: nothing is pending any more.
          if (checkIntegrity) crashes.setNeedsCheck(false);
        } catch (error) {
          const failure = databaseFailure(error, stateDir);
          crashes.setNeedsCheck(needsCheckAfter(failure.details.reason, checkIntegrity));
          dbLogger.error("the state database is unavailable; serving software commands only", {
            ...failure.details,
            error,
          });
          if (lifecycle.holdUnavailable(failure)) {
            software.append("engine.notice", {
              level: "error",
              code: DATABASE_UNAVAILABLE,
              text: failure.text,
            });
          }
        }
      },
    });
    // Every registered office loads in `recovering` (DIPO-56): its load steps end with reconcile,
    // so scheduling stays off until each office is reconciled, and the merge slot poll and Done
    // detection resume without waiting for an office command. An office that is refused stays
    // unloaded with its notice; the daemon still starts.
    steps.register({
      name: RECONCILE_STEP,
      run: async (context) => {
        for (const office of offices.registeredOffices()) {
          if (lifecycle.state !== "recovering") return;
          const access = await offices.load(office);
          if (!access.ok) {
            context.logger.warn("office not loaded at start", {
              office,
              code: access.error.code,
              reason: access.error.message,
            });
          }
        }
      },
    });
    // Re-attach (DIPO-57, 0006 decisions 7 and 8): after reconcile, every active run of a loaded
    // office follows its worker host again (or has its exit or lost host decided) before
    // scheduling turns on.
    steps.register({
      name: REATTACH_STEP,
      run: async (context) => {
        for (const office of offices.loadedOffices()) {
          if (lifecycle.state !== "recovering") return;
          for (const done of await runs.reattacher.reattach(office)) {
            context.logger.info("worker host re-attached", { office, ...done });
          }
        }
      },
    });
    // Run temp directories (DIPO-102): after re-attach, every `dipo-run-*` directory of a run that
    // ended (its hosts exited), or that no database row names when this daemon made it, goes.
    // Directories of live and re-attachable runs stay.
    steps.register({
      name: RUN_TEMP_SWEEP_STEP,
      run: async (context) => {
        const removed = await runs.tempDirs.sweep("recovery");
        if (removed.length > 0) {
          context.logger.info("removed run temp directories of ended runs", { removed });
        }
        // The boxes of box runs that ended while no daemon ran are checked and deleted too
        // (DIPO-271).
        await runs.finishEndedBoxes({ listBoxes: true });
        // And the read-only copies of reviewer sessions whose host no longer runs (DIPO-276).
        const copies = await runs.sweepReviewFolders();
        if (copies.length > 0) {
          context.logger.info("removed reviewer copies a stopped daemon left", { removed: copies });
        }
      },
    });
    // Fix rounds (DIPO-148): a round delivered just before the stop is marked so, and a reviewed
    // head whose CI will not tell again (no story PRs, or no CI) gets its round decided.
    steps.register({
      name: FIX_ROUNDS_RECOVERY_STEP,
      run: async (context) => {
        const queued = await runs.recoverFixRounds();
        if (queued > 0) context.logger.info("queued fix rounds a stopped daemon left", { queued });
      },
    });
    for (const step of options.recoverySteps ?? []) steps.register(step);
    const context: RecoveryContext = {
      logger,
      clock,
      children,
      database: () => {
        if (held.database === null) throw new Error("the state database is not open yet");
        return held.database;
      },
    };

    if (stops.requested === null) {
      const recovery = runRecovery({
        lifecycle,
        steps,
        context,
        crashLoop: crashes.crashLoop,
      }).then(
        () => ({ kind: "settled" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      const first = await Promise.race([
        recovery,
        stops.promise.then(() => ({ kind: "stop" as const })),
      ]);
      if (first.kind === "failed") throw first.error;
    }
    // Recovery loaded the registered offices: read their engine commits behind now, then on the
    // refresh interval; offices loaded later are read when status first sees them (DIPO-198).
    if (stops.requested === null) engineBehind?.start();

    if (lifecycle.state === "running" || lifecycle.state === "safe") {
      held.stableTimer = clock.setTimeout(() => {
        held.stableTimer = null;
        if (lifecycle.state !== "running" && lifecycle.state !== "safe") return;
        crashes.reset();
        logger.info("stable for 10 minutes; crash counter reset");
      }, STABLE_RUN_MS);
      // The daily backup and maintenance (DIPO-65, 0007 sections 7 and 10). Idle means no engine
      // step is running and no loaded office reports active work.
      const maintenance = new MaintenanceScheduler({
        database: () => held.database,
        clock,
        idle: () =>
          children.size === 0 &&
          offices.loadedOffices().every((office) => {
            const handle = offices.get(office);
            return (
              handle === undefined ||
              registry.activeWorkChecks().every(({ check }) => !check(handle))
            );
          }),
        logger: logger.child({ component: "maintenance" }),
      });
      held.maintenance = maintenance;
      void stops.promise
        .then(() => maintenance.stop())
        .catch((error: unknown) => {
          logger.warn("stopping maintenance failed", { error });
        });
      maintenance.start();
      keepAwake.start();
    }

    const request = await stops.promise;
    if (held.stableTimer !== null) clock.clearTimeout(held.stableTimer);
    held.stableTimer = null;
    await drain({
      lifecycle,
      children,
      clock,
      logger,
      request,
      caps: options.drainCaps ?? DEFAULT_DRAIN_CAPS,
      // `daemon.stop { stopWorkers: true }` (0006 decision 7, DIPO-315): through run control.
      stopWorkers: () => runs.control.stopAll(),
    });
    // A requested drain exits 0 and is no crash, even at its cap (0006 amendment of 2026-10-12,
    // DIPO-68). After an error no code caught it is a crash, whichever reason the drain has.
    if (stops.crashed) {
      logger.error("exiting 1 after an uncaught error; the next start counts a crash", {
        reason: request.reason,
      });
    }
    clean = !lockLost && !stops.crashed;
    return clean ? 0 : 1;
  } finally {
    if (held.lockTimer !== null) clock.clearTimeout(held.lockTimer);
    if (held.stableTimer !== null) clock.clearTimeout(held.stableTimer);
    upgrade?.stop();
    held.engineBehind?.stop();
    await keepAwake.stop();
    held.storyIndex?.stop();
    held.teardown?.stop();
    held.storyPrs?.stop();
    held.mergeSlot?.stop();
    held.ingest?.close();
    held.collisions?.stop();
    await held.boxes?.close();
    // No more debounced office summaries once the daemon stops.
    held.contract?.close();
    // A retention pass or backup still running finishes before the database closes.
    await held.retention?.stop();
    await held.maintenance?.stop();
    // Clean exit: remove dipo.sock, then dipo.pid (0006 decision 6). A daemon that lost the lock
    // leaves the socket path alone: it may belong to the daemon that holds the lock now. The
    // connections close (1001) before the database, so no request reaches a closed database.
    const ownsLock = lock.verify();
    try {
      if (held.socket !== null) {
        await held.socket.stop({ removeFile: ownsLock });
        logger.info("socket closed", { removed: ownsLock });
      }
    } finally {
      // Last, after every office task, retention and maintenance stopped: checkpoint (TRUNCATE)
      // and close, so no dipo.db-wal or dipo.db-shm stays (DIPO-87). A failure is a warn, never a
      // crash.
      held.database?.shutdown();
    }
    // Only a clean exit clears the crash marker; any other exit counts as a crash next start. An
    // error no code caught while the daemon closed down makes it unclean too (DIPO-117).
    if (stops.crashed) clean = false;
    if (clean) held.crashes?.cleanExit();
    lock.release();
    if (ownsLock) logger.info("lock released", { path: lock.path });
    // An upgrade drain ends in the new binary (0006 decision 14), started only now that the lock
    // and the socket are free, with the same environment minus the Bun flag variables.
    if (clean && stops.requested?.reason === UPGRADE_REASON && upgrade?.restarting === true) {
      try {
        const started = (options.spawnDetached ?? systemSpawnDetached)({
          cmd: [...selfCommand(), "daemon", "--foreground", "--log-level", logger.level()],
          cwd: process.cwd(),
          env: detachedEnv(io.env),
          outputFile: "/dev/null",
        });
        logger.info("started the new binary", { pid: started.pid });
      } catch (error) {
        logger.error("could not start the new binary; run `dipo daemon start`", { error });
      }
    }
    logger.info("daemon stopped", { log: logFile.path });
  }
}
