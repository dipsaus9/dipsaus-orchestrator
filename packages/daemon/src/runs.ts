// The worker start of claimed runs in the daemon (DIPO-74): the run launcher with the Claude CLI
// worker port, DIPO-39's setup, detached worker hosts and ingestion, all with the tools this
// daemon resolved on its PATH at start. `claude` and `backlog` are absolute paths, never looked up
// again; a missing `claude` refuses each launch with a notice instead of stopping the daemon.

import { realpathSync } from "node:fs";

import type {
  Clock,
  CommandName,
  IdSource,
  OfficeId,
  Spawn,
  StoryKey,
  ToolPaths,
} from "@dipsaus-orchestrator/contract";
import {
  type AdapterHolds,
  type BacklogCli,
  baseStoryFacts,
  capsOf,
  claudeWorkerPort,
  detectSafeChain,
  currentProfile,
  gitParkWriter,
  gitUnparkWriter,
  gitStoryOps,
  readBackstop,
  hostSocketSteering,
  type EngineGit,
  type HoldNotice,
  gitInputChanges,
  type Logger,
  OfficeIngest,
  type OfficeRunListener,
  type OfficeManager,
  PermissionAsks,
  type Presence,
  PlanLimits,
  type RunBase,
  RunControl,
  RunLauncher,
  RunOutcomes,
  type RunOutcomesPort,
  RunTempDirs,
  RunReattacher,
  afterRunExits,
  RunResumer,
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
  type SlotTable,
  type StateDatabase,
  type StoryClaims,
  type StoryIndex,
  systemDiskProbe,
  systemHostStarter,
  systemProcessProbe,
  systemSandboxHost,
  storyHoldsWork,
  systemSpawn,
  type currentPlatform,
  VerifyCommit,
  Watchdog,
  type WorkTracker,
} from "@dipsaus-orchestrator/engine";

/** The Backlog CLI at the absolute path the daemon resolved, else `backlog` on `PATH` (AC #8). */
export function backlogCliFor(tools: ToolPaths, spawn: Spawn = systemSpawn): BacklogCli {
  return tools.backlog === undefined ? { spawn } : { spawn, command: [tools.backlog] };
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
  /** The story index, which reads a story again after its park or In Review commit (DIPO-56). */
  readonly stories?: StoryIndex;
  /** Keep-awake's tracker: verify registers while it runs (DIPO-49, DIPO-63). */
  readonly work?: WorkTracker;
  /** Whether the maintainer is at a client, for the permission wait (DIPO-59); absent by default. */
  readonly presence?: Presence;
  /** Raises an `engine.notice` on the software stream (a plan-limit warning, DIPO-61). */
  readonly notify?: (notice: HoldNotice) => void;
  /** False while the daemon schedules no work (`safe`): held runs resume later (DIPO-61). */
  readonly scheduling?: () => boolean;
  /** The Safe-Chain proxies' private parent; `/tmp/dipo-p` by default (DIPO-84). */
  readonly safeChainRoot?: string;
}

export interface DaemonRuns {
  readonly launcher: RunLauncher;
  readonly ingest: OfficeIngest;
  /** Caps, report parks and `work.stop` (DIPO-50). */
  readonly control: RunControl;
  /** Worker outcomes and the run's next session (DIPO-51); its feature decides exits at load. */
  readonly outcomes: RunOutcomes;
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
   * The Safe-Chain checking proxies of the runs (DIPO-84): one per run while its worker session
   * runs, on a machine with Safe-Chain. `stopAll` at shutdown.
   */
  readonly safeChainProxies: SafeChainProxies;
  /**
   * The run temp directories (DIPO-102): swept after each worker exit here, and at daemon start
   * by a recovery step after re-attach (`sweep("recovery")`).
   */
  readonly tempDirs: RunTempDirs;
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
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  // The ingestion hooks call the control, and the control flushes ingestion's output first.
  let ingest: OfficeIngest | null = null;
  let outcomes: RunOutcomes | null = null;
  let exitPort: RunOutcomesPort | null = null;
  const control = new RunControl({
    finisher,
    // Each exit decision may end the run after its worker exited: its temp directory goes then.
    outcomes: () => exitPort ?? undefined,
    clock,
    offices: options.offices,
    // A `needs-permission` park asks its permission question (DIPO-75).
    ids: options.ids,
    writer: gitParkWriter({
      git: (office) => options.engineGit.forOffice(office),
      cli: options.cli,
    }),
    steering: hostSocketSteering({ clock }),
    encode: (op) => worker.encode(op),
    implemented: options.implemented,
    flushOutput: (office, run) => ingest?.flushOutput(office, run),
    onChanged: options.onChanged,
    ...(options.stories === undefined
      ? {}
      : {
          refreshStory: (office: OfficeId, key: StoryKey) =>
            options.stories?.refreshStory(office, key, { quiet: true }) ?? Promise.resolve(),
        }),
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  // The permission wait (DIPO-59): a worker's permission request asks the maintainer when present.
  const permissions = new PermissionAsks({
    clock,
    ids: options.ids,
    offices: options.offices,
    steering: hostSocketSteering({ clock }),
    encode: (op) => worker.encode(op),
    presence: options.presence ?? { connected: () => false, lastRequestAt: () => null },
    ending: (run) => control.isEnding(run),
    // An answer to a `needs-permission` park resumes its run (DIPO-75).
    parks: {
      resume: (office, run, request) =>
        outcomes?.resumePark(office, run, request) ??
        Promise.resolve({ kind: "failed", reason: "worker outcomes are not ready" }),
    },
    ...(options.scheduling === undefined ? {} : { scheduling: options.scheduling }),
    onChanged: options.onChanged,
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  // The 0014 section 8 nudges (DIPO-60): a tool use or a session start may get a short nudge.
  const nudges = new Nudges({
    clock,
    steering: hostSocketSteering({ clock }),
    encode: (op) => worker.encode(op),
    inputChanges: gitInputChanges((handle) => options.engineGit.forOffice(handle.officeId)),
    ending: (run) => control.isEnding(run),
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  // One listener per pass hears both: the permission wait and the nudges.
  const hookEvents: OfficeRunListener = {
    onWorkerEvents: (office, run, agent, events) => {
      permissions.onWorkerEvents(office, run, agent, events);
      nudges.onWorkerEvents(office, run, agent, events);
    },
    onEnded: (office, run) => {
      permissions.onEnded(office, run);
      nudges.onEnded(office, run);
      // The session's worker ended: its Safe-Chain proxy stops (DIPO-84).
      void safeChainProxies.stop(run);
      // A run that ended before its worker exited loses its temp directory now (DIPO-102).
      sweepTempDirs();
    },
  };
  ingest = new OfficeIngest({
    clock,
    hooks: control.hooks,
    hookEvents,
    pricing: () => options.database()?.pricing ?? null,
    warn: (message, fields) => options.logger.warn(message, fields),
    watchdog,
    onAppended: options.onChanged,
    // `privacy.storeCommandBodies` of the configuration in force (0007 section 8, DIPO-83).
    privacy: (office) => ({
      storeCommandBodies: options.offices.config(office)?.privacy.storeCommandBodies ?? false,
    }),
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
  // A run's next session after a crash, a full context or a missing report (DIPO-51).
  const resumer = new RunResumer({
    clock,
    ids: options.ids,
    offices: options.offices,
    worker,
    git: (office) => options.engineGit.forOffice(office),
    story: baseStoryFacts(options.base),
    runtimeDir: options.runtimeDir,
    tmpRoot: realDir(options.tmpRoot),
    hosts,
    ingest,
    control,
    onChanged: options.onChanged,
    // No new host while an earlier host of the run still runs (DIPO-57, 0006 decision 8).
    probe,
  });
  let planLimits: PlanLimits | null = null;
  outcomes = new RunOutcomes({
    waits: () => planLimits ?? undefined,
    clock,
    offices: options.offices,
    steering: hostSocketSteering({ clock }),
    encode: (op) => worker.encode(op),
    worker,
    ender: () => control,
    resumer,
    holds: options.holds,
    release,
    holdsWork: storyHoldsWork(storyGit),
    // Lifting a `needs-permission` park on the story branch before its run resumes (DIPO-75).
    unpark: gitUnparkWriter({
      git: (office) => options.engineGit.forOffice(office),
      cli: options.cli,
    }),
    ...(options.stories === undefined
      ? {}
      : {
          refreshStory: (office: OfficeId, key: StoryKey) =>
            options.stories?.refreshStory(office, key, { quiet: true }) ?? Promise.resolve(),
        }),
    caps: (office, run) => {
      const tier = tierOf(office, run);
      return tier === undefined ? null : capsOf(tier);
    },
    onChanged: options.onChanged,
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  exitPort = afterRunExits(outcomes, sweepTempDirs);
  // Re-attach after a restart (DIPO-57): every active run's newest worker host is followed again.
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
  const reattacher = new RunReattacher({
    clock,
    offices: options.offices,
    probe,
    // A worker launched through a Safe-Chain proxy that ended with the previous daemon (DIPO-84).
    proxyGone: (_office, run, host) =>
      launchedThroughSafeChain(host.runDir) && safeChainProxies.get(run.runId) === undefined
        ? safeChainProxyGoneText(run.story ?? run.runId)
        : null,
    ingest,
    control,
    outcomes,
    adapter: (office, run) => {
      const paths = runPaths(office, run);
      const config = options.offices.config(office);
      return paths === null || config === undefined
        ? null
        : (worker.adapter(paths, config) as IngestAdapter);
    },
    initialState: ({ office, run, agent, resume, previous }) => {
      const paths = runPaths(office, run);
      const tier = tierOf(office, run);
      if (paths === null || tier === undefined) return {};
      const spec = runWorkerSpec({ runId: run.runId, agent, caps: tier }, paths, "", {
        id: "",
        resume,
      });
      return worker.initialState(spec, previous);
    },
    caps: (office, run) => {
      const tier = tierOf(office, run);
      return tier === undefined ? null : capsOf(tier);
    },
    onChanged: options.onChanged,
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  const runOutcomes = outcomes;
  planLimits = new PlanLimits({
    clock,
    offices: options.offices,
    resume: (office, run, why) => runOutcomes.resumeWait(office, run, why),
    holds: options.holds,
    ...(options.notify === undefined ? {} : { notify: options.notify }),
    ...(options.scheduling === undefined ? {} : { scheduling: options.scheduling }),
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  const launcher = new RunLauncher({
    worker,
    git: (office) => options.engineGit.forOffice(office),
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
          warn: (message, fields) => options.logger.warn(message, { office, ...fields }),
        },
        {
          claim,
          config,
          profile: currentProfile(handle)?.profile ?? null,
          host: { home, uid, env },
        },
      );
    },
    dependencies: async (office, ids) =>
      ids.length === 0 ? [] : (await options.base.read(office, ids)).views,
    runtimeDir: options.runtimeDir,
    tmpRoot: realDir(options.tmpRoot),
    // The daemon-start sweep removes a run it does not know only when this daemon made it.
    tempOwner: () => tempDirs.owner(),
    hosts,
    ingest,
    control,
    snapshot: (office, worktree) => readBackstop(gitOf(office), worktree),
    release,
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  return {
    launcher,
    ingest,
    control,
    outcomes,
    permissions,
    nudges,
    reattacher,
    planLimits,
    safeChainProxies,
    tempDirs,
  };
}
