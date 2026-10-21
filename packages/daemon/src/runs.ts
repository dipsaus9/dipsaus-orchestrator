// The worker start of claimed runs in the daemon (DIPO-74): the run launcher with the Claude CLI
// worker port, DIPO-39's setup, detached worker hosts and ingestion, all with the tools this
// daemon resolved on its PATH at start. `claude` and `backlog` are absolute paths, never looked up
// again; a missing `claude` refuses each launch with a notice instead of stopping the daemon.
//
// Box workers (DIPO-271, 0021): with Apple `container` on the daemon's PATH, a run started with
// `work.run`'s `box` runs its developer in its own box (`BoxWorkers`). The box ends with its run:
// after each exit decision the boxes of ended runs get the post-run token check and are deleted,
// and so are those a stopped daemon left (`finishEndedBoxes`, at the recovery step). At start the
// token check's leftover export folders are swept.

import { realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type {
  Clock,
  CommandName,
  IdSource,
  OfficeId,
  RunId,
  Spawn,
  StoryKey,
  ToolPaths,
} from "@dipsaus-orchestrator/contract";
import {
  type AdapterHolds,
  AppleContainerBoxes,
  BOX_INDEX_DIR,
  type BoxBuildNetwork,
  type BoxNetwork,
  type BoxPort,
  BoxWorkers,
  CLAUDE_CLI_ADAPTER_ID,
  ensurePrivateDir,
  findRun,
  readBaseBox,
  startBoxWebRoute,
  startModelProxy,
  sweepTokenCheckLeftovers,
  systemIsExecutable,
  systemListenHttp,
  workerHostsOf,
  type BacklogCli,
  capsOf,
  claudeWorkerPort,
  detectSafeChain,
  currentProfile,
  gitParkWriter,
  gitUnparkWriter,
  gitStoryOps,
  hostSocketSteering,
  type EngineGit,
  type HoldNotice,
  gitInputChanges,
  type Logger,
  OfficeIngest,
  type OfficeHandle,
  type OfficeManager,
  type ParseState,
  PermissionAsks,
  type Places,
  type Presence,
  PlanLimits,
  type Resumption,
  type RunBase,
  RunControl,
  RunLauncher,
  composeRuns,
  RunOutcomes,
  RunTempDirs,
  RunReattacher,
  runCaps,
  runLaunchPaths,
  runSandboxedStep,
  runWorkerSpec,
  SafeChainProxies,
  startSafeChainProxy,
  launchedThroughSafeChain,
  safeChainProxyGoneText,
  sweepSafeChainProxies,
  type IngestAdapter,
  Nudges,
  type StoredRun,
  selfCommand,
  setupWorktree,
  type HoldResumer,
  type SlotTable,
  type TierCaps,
  type WorkerPort,
  type StateDatabase,
  type StoryClaims,
  type StoryIndex,
  systemDiskProbe,
  systemHostStarter,
  signalProcess,
  startTierOf,
  systemProcessProbe,
  systemSandboxHost,
  storyHoldsWork,
  systemSpawn,
  type currentPlatform,
  VerifyCommit,
  Watchdog,
  type WorkTracker,
} from "@dipsaus-orchestrator/engine";

/**
 * The Backlog CLI at the absolute path the daemon resolved, else `backlog` on `PATH` (AC #8). The
 * runner gives each call only `PATH` and `HOME` of the daemon's environment (`backlogEnv`), and a
 * story's calls run in dipo's own copy of its backlog, never its worktree (0021 section 14).
 */
export function backlogCliFor(tools: ToolPaths, spawn: Spawn = systemSpawn): BacklogCli {
  return tools.backlog === undefined ? { spawn } : { spawn, command: [tools.backlog] };
}

/**
 * A re-attached session's initial state, built with the model and effort its run started with, not
 * the office tier in force (DIPO-207).
 */
export function startedSessionState(
  worker: Pick<WorkerPort, "reportSchema" | "initialState">,
  handle: OfficeHandle,
  run: StoredRun,
  agent: string,
  inForce: TierCaps,
  paths: Parameters<typeof runWorkerSpec>[2],
  resume: boolean,
  previous?: ParseState,
): ParseState {
  const tier = startTierOf(handle, run, inForce);
  const spec = runWorkerSpec(worker, { runId: run.runId, agent, caps: tier }, paths, "", {
    id: "",
    resume,
  });
  return worker.initialState(spec, previous);
}

export interface DaemonRunsOptions {
  readonly tools: ToolPaths;
  readonly platform: ReturnType<typeof currentPlatform>;
  readonly clock: Clock;
  /** Ids of the agents a run's next session makes (DIPO-51). */
  readonly ids: IdSource;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly uid: number;
  readonly runtimeDir: string;
  /** Where each run's sandbox temp directory is made. */
  readonly tmpRoot: string;
  /** dipo's state folder: the box workers keep their index of unfinished boxes in it (DIPO-271). */
  readonly stateDir: string;
  readonly holds: AdapterHolds;
  readonly engineGit: EngineGit;
  readonly claims: StoryClaims;
  readonly offices: OfficeManager;
  readonly slots: SlotTable;
  readonly base: RunBase;
  readonly database: () => StateDatabase | null;
  readonly onChanged: (office: OfficeId) => void;
  readonly logger: Logger;
  /** The Backlog CLI the park commit runs (DIPO-50). */
  readonly cli: BacklogCli;
  /** True when the engine implements a command; a park offers only those (DIPO-50). */
  readonly implemented: (name: CommandName) => boolean;
  /** The story PR, opened or updated right after each In Review push (DIPO-144). */
  readonly storyPr?: { sync(office: OfficeId, runId: RunId): Promise<void> };
  /** The planning lane's resume of an on-hold park, for `work.resume` (DIPO-160). */
  readonly holdResumer?: () => HoldResumer | undefined;
  /** The story index, which reads a story again after its park or In Review commit (DIPO-56). */
  readonly stories?: StoryIndex;
  /** Keep-awake's tracker: verify registers while it runs (DIPO-49, DIPO-63). */
  readonly work?: WorkTracker;
  /** Whether a TUI is connected, for live questions (DIPO-279); none by default. */
  readonly presence?: Presence;
  /** Raises an `engine.notice` on the software stream (a plan-limit warning, DIPO-61). */
  readonly notify?: (notice: HoldNotice) => void;
  /** False while the daemon schedules no work (`safe`): held runs resume later (DIPO-61). */
  readonly scheduling?: () => boolean;
  /** The Safe-Chain proxies' private parent; `/tmp/dipo-p` by default (DIPO-84). */
  readonly safeChainRoot?: string;
  /**
   * The box backend (DIPO-271); by default Apple `container` when the daemon's PATH has it, and
   * no box workers otherwise. Tests pass a fake.
   */
  readonly boxes?: BoxPort | null;
}

export interface DaemonRuns {
  readonly launcher: RunLauncher;
  readonly ingest: OfficeIngest;
  /** Caps, report parks and `work.stop` (DIPO-50). */
  readonly control: RunControl;
  /** Worker outcomes and the run's next session (DIPO-51); its feature decides exits at load. */
  readonly outcomes: RunOutcomes;
  /**
   * Park resume and `work.resume` (DIPO-138): `work.answer` on a `needs-permission` park resumes
   * through it, and its feature rides on the plan-limit schedule's.
   */
  readonly resumption: Resumption;
  /** The permission wait and `work.answer` (DIPO-59). */
  readonly permissions: PermissionAsks;
  /** The 0014 section 8 nudges (DIPO-60). */
  readonly nudges: Nudges;
  /** Re-attach of worker hosts after a restart (DIPO-57), a recovery step after reconcile. */
  readonly reattacher: RunReattacher;
  /**
   * The plan-limit schedule (DIPO-61): holds scheduling while a plan limit is open, resumes held
   * runs after the reset, recovers waits at load and implements `work.resume` for held runs.
   */
  readonly planLimits: PlanLimits;
  /**
   * The office's worker and reviewer places (DIPO-142): a resume whose place is taken waits and
   * starts when it frees; its feature starts what waited across a restart at load.
   */
  readonly places: Places;
  /**
   * The Safe-Chain checking proxies of the runs (DIPO-84): one per run while its worker session
   * runs, on a machine with Safe-Chain. `stopAll` at shutdown.
   */
  readonly safeChainProxies: SafeChainProxies;
  /**
   * The run temp directories (DIPO-102): swept after each worker exit here, and at daemon start
   * by a recovery step after re-attach (`sweep("recovery")`).
   */
  readonly tempDirs: RunTempDirs;
  /** The box workers (DIPO-271); null without a box backend. `close` at daemon stop. */
  readonly boxes: BoxWorkers | null;
  /**
   * Checks and deletes the box of every run that ended (DIPO-271): after each exit decision
   * here, and at daemon start by the recovery step, which also asks the backend for dipo's boxes
   * (`listBoxes`). Never rejects.
   */
  finishEndedBoxes(options?: { readonly listBoxes?: boolean }): Promise<void>;
}

/** Apple `container` on `pathEnv`, by absolute path; undefined when it is not there. */
export function containerOnPath(
  pathEnv: string | undefined,
  isExecutable: (path: string) => boolean = systemIsExecutable,
): string | undefined {
  return (pathEnv ?? "")
    .split(":")
    .filter((dir) => dir !== "" && isAbsolute(dir))
    .map((dir) => join(dir, "container"))
    .find((path) => isExecutable(path));
}

/** True when `host` has exited, as its row records it. */
function hostExited(host: ReturnType<typeof workerHostsOf>[number]): boolean {
  return host.endedAt !== null || host.exitCode !== null || host.exitSignal !== null;
}

/**
 * Whether run `runId` ended with every worker host exited (true), still goes (false), or is
 * unknown to every loaded office (null), for `BoxWorkers.finishEnded`.
 */
export function boxRunEnded(
  offices: Pick<DaemonRunsOptions["offices"], "loadedOffices" | "get">,
  runId: string,
  read: {
    readonly run: (
      handle: OfficeHandle,
      runId: RunId,
    ) => { readonly endedAt: number | null } | null;
    readonly hosts: (handle: OfficeHandle, runId: string) => ReturnType<typeof workerHostsOf>;
  } = { run: findRun, hosts: workerHostsOf },
): boolean | null {
  for (const office of offices.loadedOffices()) {
    const handle = offices.get(office);
    if (handle === undefined) continue;
    const run = read.run(handle, runId as RunId);
    if (run === null) continue;
    return run.endedAt !== null && read.hosts(handle, runId).every(hostExited);
  }
  return null;
}

/**
 * Removes the export folders a post-run token check left in `tmpRoot` (a crash, a failed
 * removal): they may hold a leaked token (DIPO-269). Runs at daemon start; never rejects.
 */
export async function sweepBoxTokenChecks(
  tmpRoot: string,
  logger: Pick<Logger, "info">,
): Promise<number> {
  const removed = await sweepTokenCheckLeftovers(tmpRoot);
  if (removed > 0) logger.info("removed token check exports a stopped daemon left", { removed });
  return removed;
}

/** The box workers of the daemon (DIPO-271), or null without a box backend. */
function daemonBoxWorkers(options: DaemonRunsOptions, tmpRoot: string): BoxWorkers | null {
  const { clock, platform, env, home, uid } = options;
  let boxes = options.boxes;
  if (boxes === undefined) {
    const cli = containerOnPath(env["PATH"]);
    boxes =
      cli === undefined
        ? null
        : new AppleContainerBoxes({
            spawn: systemSpawn,
            clock,
            cli,
            // The `container` client's own environment; a box never inherits it.
            env: { PATH: env["PATH"] ?? "/usr/bin:/bin", HOME: home },
          });
  }
  if (boxes === null) return null;
  const routeRoot = join(tmpRoot, "dipo-box-routes");
  const scratchRoot = join(tmpRoot, "dipo-box-builds");
  let routes = 0;
  // dipo's web route (Safe-Chain behind the web proxy) on a network's host address: the box
  // network's for the boxes, the builder's for one image build.
  const startRoute = async (network: Pick<BoxNetwork, "hostAddress"> | BoxBuildNetwork) => {
    ensurePrivateDir(routeRoot);
    routes += 1;
    const dir = join(routeRoot, `route-${routes}`);
    const started = await startBoxWebRoute(
      network,
      {
        request: {
          installRoot: `${home}/.safe-chain`,
          caFile: join(dir, "ca.pem"),
          home,
          uid,
          env,
        },
        deps: {
          platform,
          clock,
          ...(options.safeChainRoot === undefined ? {} : { root: options.safeChainRoot }),
        },
      },
      { clock },
    );
    if (!started.ok) {
      rmSync(dir, { recursive: true, force: true });
      return started;
    }
    const route = started.route;
    return {
      ok: true as const,
      route: {
        ...route,
        stop: async () => {
          try {
            await route.stop();
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      },
    };
  };
  return new BoxWorkers({
    boxes,
    startWebRoute: startRoute,
    startBuildRoute: startRoute,
    startModelProxy: (network) =>
      startModelProxy({
        network,
        keychain: { spawn: systemSpawn, clock, env: { PATH: "/usr/bin:/bin", HOME: home } },
        listen: systemListenHttp,
        log: (line) => options.logger.debug("model proxy", { line }),
      }),
    readBaseBox: (git) => readBaseBox(git),
    code: { spawn: systemSpawn, clock },
    holds: options.holds,
    adapter: CLAUDE_CLI_ADAPTER_ID,
    tmpRoot,
    indexDir: join(options.stateDir, BOX_INDEX_DIR),
    // The part queue of each box is read while its session runs (DIPO-272); delivering a part is
    // DIPO-273's `onPart`.
    door: {},
    scratchRoot: (() => {
      ensurePrivateDir(scratchRoot);
      return scratchRoot;
    })(),
    warn: (message, fields) => options.logger.warn(message, fields),
    info: (message, fields) => options.logger.info(message, fields),
  });
}

/**
 * The real path of `dir` (on macOS `/tmp` is a link to `/private/tmp`), so the sandbox paths of a
 * run name the directory itself; `dir` as given when it cannot be resolved.
 */
export function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The run launcher `work.run` starts workers with. */
export function daemonRuns(options: DaemonRunsOptions): DaemonRuns {
  const { clock, platform, env, home, uid } = options;
  const runStep = (request: Parameters<typeof runSandboxedStep>[1]) =>
    runSandboxedStep({ clock, platform, host: systemSandboxHost(platform) }, request);
  // The watchdog (DIPO-52) writes `quiet` and `no-output` by the office's `timeouts`, and every
  // entry ingestion or the watchdog appends reaches subscribers at once.
  const watchdog = new Watchdog({
    clock,
    timeouts: (office) => options.offices.config(office)?.timeouts,
    onAppended: options.onChanged,
  });
  const probe = systemProcessProbe(platform);
  // Run temp directories (DIPO-102): removed once their run ended and its worker hosts exited,
  // swept after each exit and its decision, and at daemon start (`sweepTempDirs`).
  // Box workers (DIPO-271); their token check exports a stopped daemon left go first.
  const boxWorkers = daemonBoxWorkers(options, realDir(options.tmpRoot));
  void sweepBoxTokenChecks(realDir(options.tmpRoot), options.logger).catch(() => {});
  const finishEndedBoxes = async (
    finishOptions: { readonly listBoxes?: boolean } = {},
  ): Promise<void> => {
    if (boxWorkers === null) return;
    const finished = await boxWorkers.finishEnded(
      (runId) => boxRunEnded(options.offices, runId),
      finishOptions,
    );
    if (finished.length > 0)
      options.logger.info("ended box runs checked and deleted", { finished });
  };
  const tempDirs = new RunTempDirs({
    tmpRoot: realDir(options.tmpRoot),
    database: options.database,
    probe,
    ...(uid >= 0 ? { uid } : {}),
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  const sweepTempDirs = (): void => {
    void tempDirs.sweep("ended").then(
      (removed) => {
        if (removed.length > 0)
          options.logger.info("removed ended runs' temp directories", { removed });
      },
      (error: unknown) =>
        options.logger.warn("sweeping run temp directories failed", {
          reason: error instanceof Error ? error.message : String(error),
        }),
    );
  };
  // Worker installs go through a Safe-Chain checking proxy per run, sandboxed itself (DIPO-84).
  // Proxy directories a killed daemon left behind go first; a running daemon's stay.
  void sweepSafeChainProxies(options.safeChainRoot).then(
    (removed) => {
      if (removed.length > 0) {
        options.logger.info("removed Safe-Chain proxy directories a stopped daemon left", {
          removed,
        });
      }
    },
    () => {},
  );
  const safeChainProxies = new SafeChainProxies({
    clock,
    start: ({ caFile }) =>
      startSafeChainProxy(
        { installRoot: `${home}/.safe-chain`, caFile, home, uid, env },
        {
          platform,
          clock,
          ...(options.safeChainRoot === undefined ? {} : { root: options.safeChainRoot }),
        },
      ),
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  const worker = claudeWorkerPort({
    spawn: systemSpawn,
    clock,
    claudePath: options.tools.claude,
    home,
    env,
    holds: options.holds,
    platform,
    runStep,
    uid,
    // The run settings file's hooks run this binary (DIPO-59).
    dipoCommand: selfCommand(),
    // Workers run package managers through the official Safe-Chain when it is installed (DIPO-82).
    detectSafeChain: (input) => detectSafeChain(input),
    safeChainProxies,
    warn: (message, fields) => options.logger.warn(message, fields),
    ...(boxWorkers === null ? {} : { boxes: boxWorkers }),
  });
  const tierOf = (office: OfficeId, run: StoredRun) =>
    run.tier === null
      ? undefined
      : options.offices.config(office)?.tiers[run.tier as "S" | "M" | "L"];
  const gitOf = (office: OfficeId) => {
    const git = options.engineGit.forOffice(office);
    if (git === undefined) throw new Error(`Office ${office} has no git attached.`);
    return git;
  };
  const storyGit = gitStoryOps({
    git: (office) => options.engineGit.forOffice(office),
    cli: options.cli,
  });
  // Verify and commit at In Review and the backstop after every turn (DIPO-49).
  const finisher = new VerifyCommit({
    clock,
    story: storyGit,
    mainCheckout: (office) => gitOf(office).mainWorktree,
    runStep,
    config: (office) => options.offices.config(office),
    profile: (office) => currentProfile(office)?.profile ?? null,
    host: { home, uid, env },
    ...(options.work === undefined ? {} : { work: options.work }),
    ...(options.storyPr === undefined ? {} : { storyPr: options.storyPr }),
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  const started = systemHostStarter({
    clock,
    runtimeDir: options.runtimeDir,
    dipoCommand: selfCommand(),
    env,
    probe,
  });
  // A started worker host keeps its run's Safe-Chain proxy until the session ends (DIPO-84).
  const hosts: typeof started = {
    start: async (office, launch) => {
      const host = await started.start(office, launch);
      safeChainProxies.hostStarted(launch.runId);
      return host;
    },
  };
  const release = (
    office: OfficeId,
    claim: Parameters<StoryClaims["releaseUnstarted"]>[1],
    reason: string,
  ) => options.claims.releaseUnstarted(office, claim, reason);
  const runPaths = (office: OfficeId, run: StoredRun) => {
    const git = options.engineGit.forOffice(office);
    if (git === undefined || run.worktree === null) return null;
    return runLaunchPaths(
      git,
      { runtimeDir: options.runtimeDir, tmpRoot: realDir(options.tmpRoot) },
      run.worktree,
      run.runId,
    );
  };
  const capsFor = (office: OfficeId, run: StoredRun) => {
    const tier = tierOf(office, run);
    const handle = options.offices.get(office);
    return tier === undefined || handle === undefined ? null : runCaps(handle, run, capsOf(tier));
  };
  const refreshStory = options.stories;
  // One steering for every run service: it keeps no state between sends.
  const steering = hostSocketSteering({ clock, probe, signal: signalProcess });
  const composed = composeRuns({
    clock,
    ids: options.ids,
    offices: options.offices,
    worker,
    steering,
    hosts,
    git: (office) => options.engineGit.forOffice(office),
    // A launch's dependencies and a run's next session read the stories on the base (DIPO-51).
    base: options.base,
    runtimeDir: options.runtimeDir,
    tmpRoot: realDir(options.tmpRoot),
    // The daemon-start sweep removes a run it does not know only when this daemon made it.
    tempOwner: () => tempDirs.owner(),
    ...(options.holdResumer === undefined ? {} : { holdResumer: options.holdResumer }),
    onChanged: options.onChanged,
    warn: (message, fields) => options.logger.warn(message, fields),
    ...(refreshStory === undefined
      ? {}
      : {
          refreshStory: (office: OfficeId, key: StoryKey) =>
            refreshStory.refreshStory(office, key, { quiet: true }),
        }),
    release,
    // Each exit decision may end the run after its worker exited: its temp directory goes then,
    // and a box run's box is checked and deleted (DIPO-271).
    afterExit: () => {
      sweepTempDirs();
      void finishEndedBoxes();
    },
    ...(boxWorkers === null ? {} : { boxes: boxWorkers }),
    // The permission wait (DIPO-59) asks the maintainer when present, and holds while `safe`.
    ...(options.presence === undefined ? {} : { presence: options.presence }),
    ...(options.scheduling === undefined ? {} : { scheduling: options.scheduling }),
    // The 0014 section 8 nudges (DIPO-60): a resume may get an input nudge.
    inputChanges: gitInputChanges((handle) => options.engineGit.forOffice(handle.officeId)),
    ingest: {
      pricing: () => options.database()?.pricing ?? null,
      watchdog,
      onEnded: (_office, run) => {
        // The session's worker ended: its Safe-Chain proxy stops (DIPO-84).
        void safeChainProxies.stop(run);
        // A run that ended before its worker exited loses its temp directory now (DIPO-102).
        sweepTempDirs();
        void finishEndedBoxes();
      },
    },
    control: {
      finisher,
      // A `needs-permission` park asks its permission question (DIPO-75).
      writer: gitParkWriter({
        git: (office) => options.engineGit.forOffice(office),
        cli: options.cli,
      }),
      implemented: options.implemented,
    },
    outcomes: {
      // No new host while an earlier host of the run still runs (DIPO-57, 0006 decision 8).
      probe,
      holds: options.holds,
      holdsWork: storyHoldsWork(storyGit),
      // Lifting a `needs-permission` park on the story branch before its run resumes (DIPO-75).
      unpark: gitUnparkWriter({
        git: (office) => options.engineGit.forOffice(office),
        cli: options.cli,
      }),
      caps: capsFor,
    },
    // The plan-limit schedule (DIPO-61): holds scheduling while a plan limit is open, resumes held
    // runs after the reset, recovers waits at load and implements `work.resume` for held runs.
    planLimits: {
      holds: options.holds,
      ...(options.notify === undefined ? {} : { notify: options.notify }),
    },
    // DIPO-39's worktree setup of a claimed story, before its worker starts.
    setup: async (office, claim) => {
      const handle = options.offices.get(office);
      const config = options.offices.config(office);
      const git = options.engineGit.forOffice(office);
      if (handle === undefined || config === undefined || git === undefined) {
        const reason = `office ${office} is not loaded with a valid configuration`;
        return { ok: false, reason, log: `setup: ${reason}` };
      }
      return setupWorktree(
        {
          officeId: office,
          office: handle,
          git,
          clock,
          onChanged: options.onChanged,
          disk: systemDiskProbe,
          slots: options.slots,
          runStep,
          localSettings: worker.localSettings,
          warn: (message, fields) => options.logger.warn(message, { office, ...fields }),
          debug: (message, fields) => options.logger.debug(message, { office, ...fields }),
        },
        {
          claim,
          config,
          profile: currentProfile(handle)?.profile ?? null,
          host: { home, uid, env },
        },
      );
    },
    // Re-attach after a restart (DIPO-57): every active run's newest worker host is followed again.
    reattach: {
      probe,
      // A living host of an ended run whose stop did not reach it is stopped again (DIPO-93).
      steering,
      // A worker launched through a Safe-Chain proxy that ended with the previous daemon (DIPO-84).
      proxyGone: (_office, run, host) =>
        launchedThroughSafeChain(host.runDir) && safeChainProxies.get(run.runId) === undefined
          ? safeChainProxyGoneText(run.story ?? run.runId)
          : null,
      adapter: (office, run) => {
        const paths = runPaths(office, run);
        const config = options.offices.config(office);
        return paths === null || config === undefined
          ? null
          : (worker.adapter(paths, config) as IngestAdapter);
      },
      initialState: ({ office, run, agent, resume, previous }) => {
        const paths = runPaths(office, run);
        const inForce = tierOf(office, run);
        const handle = options.offices.get(office);
        if (paths === null || inForce === undefined || handle === undefined) return {};
        return startedSessionState(worker, handle, run, agent, inForce, paths, resume, previous);
      },
      caps: capsFor,
    },
  });
  const {
    ingest,
    control,
    outcomes,
    resumption,
    permissions,
    nudges,
    reattacher,
    planLimits,
    places,
    launcher,
  } = composed;
  if (
    control === null ||
    outcomes === null ||
    resumption === null ||
    reattacher === null ||
    planLimits === null ||
    places === null
  ) {
    throw new Error("the daemon's run services are not all wired");
  }
  return {
    launcher,
    ingest,
    control,
    outcomes,
    resumption,
    permissions,
    nudges,
    reattacher,
    planLimits,
    places,
    safeChainProxies,
    tempDirs,
    boxes: boxWorkers,
    finishEndedBoxes,
  };
}
