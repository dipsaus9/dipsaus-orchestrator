// The worker start of claimed runs in the daemon (DIPO-74): the run launcher with the Claude CLI
// worker port, DIPO-39's setup, detached worker hosts and ingestion, all with the tools this
// daemon resolved on its PATH at start. `claude` and `backlog` are absolute paths, never looked up
// again; a missing `claude` refuses each launch with a notice instead of stopping the daemon.
//
// Box workers (DIPO-271, 0021): with Apple `container` on the daemon's PATH, every run's developer
// works in its story's box (`BoxWorkers`, DIPO-240); without it no developer starts. A box lives
// from claim to merge (DIPO-278): after each exit decision, on a minute tick and at the recovery
// step (`finishEndedBoxes`), the box of a run that waits is checked for the token and stopped, and
// the box of a run whose claim ended (merge, drop, discard) is checked and deleted, also those a
// stopped daemon left. At start the
// token check's leftover export folders and the part stage folders a stopped daemon left are swept.
// Each box gets its office's package cache (DIPO-295): one root per office under
// `<state>/PACKAGE_CACHE_DIR` (`boxPackageCache`), filled in a fill box through the daemon's web
// route or reused, and mounted read-only; Apple `container` mounts only a cache under that folder.
// Each image's box network tools (DIPO-281) are kept under `<state>/BOX_NET_TOOLS_DIR` and mounted
// read-only into every box of the image; Apple `container` mounts only tools under that folder.
// The web guard and each reviewer's web proxy read the box network's host address from the box
// workers, live (DIPO-281).

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
import { Lifecycle } from "@dipsaus-orchestrator/contract";
import {
  type AdapterHolds,
  type BoxEnded,
  type BoxPassOptions,
  boxEndedOf,
  boxRunState,
  findClaim,
  AppleContainerBoxes,
  appendEntries,
  BOX_INDEX_DIR,
  BOX_NET_TOOLS_DIR,
  baseStoryFacts,
  BoxCollisions,
  boxInstallInput,
  inReviewRunIds,
  markBoxCopied,
  pendingBoxCopy,
  type MergeGatesDeps,
  type StorySlotDeps,
  StoryConflicts,
  type UnparkWriter,
  type BoxNetwork,
  type BoxPort,
  BoxParts,
  type BoxPartsDeps,
  BoxWorkers,
  type BoxPackageCacheDeps,
  type DoorPart,
  boxName,
  CLAUDE_CLI_ADAPTER_ID,
  ensurePrivateDir,
  findRun,
  officePackageCacheRoot,
  PACKAGE_CACHE_DIR,
  readBaseBox,
  startBoxWebRoute,
  startModelProxy,
  partStageRoot,
  sweepPartStages,
  sweepReviewFolders,
  sweepTokenCheckLeftovers,
  systemIsExecutable,
  systemListenHttp,
  workerHostsOf,
  type BacklogCli,
  capsOf,
  claudeWorkerPort,
  currentProfile,
  gitParkWriter,
  gitUnparkWriter,
  gitStoryOps,
  hostSocketSteering,
  type EngineGit,
  type HoldNotice,
  type CiHeadState,
  type Logger,
  OfficeIngest,
  type OfficeHandle,
  type OfficeManager,
  type ParseState,
  type ScanSessionRunner,
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
  runWorkerSpec,
  sweepSafeChainProxies,
  type IngestAdapter,
  Nudges,
  type PartRun,
  type SyncOutcome,
  type BranchPush,
  recordBranchPush,
  type StoredRun,
  selfCommand,
  setupWorktree,
  type HoldResumer,
  type SlotReentry,
  type SlotTable,
  type TierCaps,
  type WorkerPort,
  type StateDatabase,
  type StoryClaims,
  type StoryIndex,
  systemHostStarter,
  signalProcess,
  startTierOf,
  systemProcessProbe,
  storyHoldsWork,
  systemSpawn,
  type currentPlatform,
  VerifyCommit,
  Watchdog,
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
  /**
   * The story PR, opened or updated right after each In Review push (DIPO-144), with the CI of its
   * pushed head, which a fix round waits for and carries (DIPO-147, DIPO-148).
   */
  readonly storyPr?: {
    sync(office: OfficeId, runId: RunId): Promise<void>;
    /** A new story PR in place of one closed on the host, after a resume (0002, DIPO-324). */
    replace?(office: OfficeId, runId: RunId): Promise<void>;
    ciState?(office: OfficeId, runId: RunId): CiHeadState | null;
    onCiFinal?(listener: (office: OfficeId, runId: RunId) => void): void;
  };
  /** The planning lane's resume of a park with no run, for `work.resume` (DIPO-160). */
  readonly holdResumer?: () => HoldResumer | undefined;
  /** The merge slot a story waiting In Review again re-enters after a resume (DIPO-150). */
  readonly slotReentry?: () => SlotReentry | undefined;
  /** The story index, which reads a story again after its park or In Review commit (DIPO-56). */
  readonly stories?: StoryIndex;
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
  /**
   * Wraps the Claude CLI worker port; a test daemon process plans a scripted worker with it
   * (DIPO-316). The port as it is by default.
   */
  readonly workerPort?: (port: WorkerPort) => WorkerPort;
}

export interface DaemonRuns {
  readonly launcher: RunLauncher;
  readonly ingest: OfficeIngest;
  /** Caps, report parks and `story.park` of a story with a run (DIPO-50). */
  readonly control: RunControl;
  /** Worker outcomes and the run's next session (DIPO-51); its feature decides exits at load. */
  readonly outcomes: RunOutcomes;
  /**
   * Park resume and `work.resume` (DIPO-138): `work.answer` on an `ambiguous-spec` park resumes
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
   * The run temp directories (DIPO-102): swept after each worker exit here, and at daemon start
   * by a recovery step after re-attach (`sweep("recovery")`).
   */
  readonly tempDirs: RunTempDirs;
  /** The box workers (DIPO-271); null without a box backend. `close` at daemon stop. */
  readonly boxes: BoxWorkers | null;
  /**
   * Whether a run's developer works in a box (DIPO-271): the story PR's CI watch reads it, since CI
   * is the verify of a box run (DIPO-299). False without a box backend.
   */
  isBoxRun(office: OfficeId, run: StoredRun): boolean;
  /** The collision check of the box runs (DIPO-277); null without a box backend. `stop` at daemon stop. */
  readonly collisions: BoxCollisions | null;
  /**
   * Checks and deletes the box of every run that ended (DIPO-271): after each exit decision
   * here, and at daemon start by the recovery step, which also asks the backend for dipo's boxes
   * (`listBoxes`). Never rejects.
   */
  finishEndedBoxes(options?: { readonly listBoxes?: boolean }): Promise<void>;
  /** Stops the minute tick of the box passes (DIPO-278), at daemon stop. */
  stopBoxPasses(): void;
  /**
   * Removes the folder of every reviewer session whose host no longer runs (DIPO-276), with its
   * read-only copy of the pushed commit: at daemon start by the recovery step. Never rejects.
   */
  sweepReviewFolders(): Promise<string[]>;
  /**
   * The fix rounds' recovery (DIPO-148), at daemon start: a round whose session started before the
   * stop is marked delivered, and every run that ended reviewed gets its round decided. Returns how
   * many rounds it queued.
   */
  recoverFixRounds(): Promise<number>;
  /**
   * The merge slot's ports into the run services (DIPO-150): a conflict the slot's sync committed
   * goes to the worker as one fix round, a maintainer reject as another, a merge the slot made is
   * recorded (so a clean one carries the approval to the merged head), and the story's facts on
   * the base are read as the review loop reads them.
   */
  readonly mergeSlot: DaemonMergeSlotPorts;
  /** The scan fallback's `session` runs (DIPO-310), which `office.infer` starts. */
  readonly sessions: ScanSessionRunner;
}

/** What the merge slot and the merge gates use of the run services (DIPO-150). */
export interface DaemonMergeSlotPorts {
  readonly conflict: NonNullable<StorySlotDeps["conflict"]>;
  readonly reject: NonNullable<MergeGatesDeps["reject"]>;
  readonly recordMerge: NonNullable<StorySlotDeps["recordMerge"]>;
  readonly story: NonNullable<StorySlotDeps["story"]>;
  readonly itemMax: NonNullable<StorySlotDeps["itemMax"]>;
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
 * What the daemon's pass does with run `runId`'s box (DIPO-278, `boxRunState`), as
 * `BoxWorkers.finishEnded` asks it: true when the run's claim ended (merge, drop, discard) and every
 * worker host exited (the box is deleted), `BOX_WAITING` when the run ended with its claim live and
 * its hosts exited (the story waits: the box stops, files kept), false while a session runs or may
 * start, null when no loaded office knows the run.
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
    readonly claim: (
      handle: OfficeHandle,
      runId: RunId,
    ) => { readonly releasedAt: number | null } | null;
  } = { run: findRun, hosts: workerHostsOf, claim: findClaim },
): BoxEnded {
  for (const office of offices.loadedOffices()) {
    const handle = offices.get(office);
    if (handle === undefined) continue;
    const run = read.run(handle, runId as RunId);
    if (run === null) continue;
    const claim = read.claim(handle, runId as RunId);
    return boxEndedOf(
      boxRunState({
        endedAt: run.endedAt,
        claimLive: claim === null ? null : claim.releasedAt === null,
        hostsExited: read.hosts(handle, runId).every(hostExited),
      }),
    );
  }
  return null;
}

/**
 * True when run `runId` has a worker host of `agent` that has not exited in a loaded office: a
 * reviewer session whose read-only copy stays (DIPO-276).
 */
export function reviewHostRuns(
  offices: Pick<DaemonRunsOptions["offices"], "loadedOffices" | "get">,
  runId: string,
  agent: string,
  hosts: (handle: OfficeHandle, runId: string) => ReturnType<typeof workerHostsOf> = workerHostsOf,
): boolean {
  for (const office of offices.loadedOffices()) {
    const handle = offices.get(office);
    if (handle === undefined) continue;
    if (hosts(handle, runId).some((host) => host.agentId === agent && !hostExited(host))) {
      return true;
    }
  }
  return false;
}

/**
 * Checks and deletes the boxes of the runs that ended (`BoxWorkers.finishEnded`) and logs the
 * runs a pass finished. Each exit decision and the end of its ingestion both call it; the passes
 * run one after another, so each deleted run is logged once (DIPO-307). Never rejects.
 */
export async function finishEndedBoxRuns(
  workers: Pick<BoxWorkers, "finishEnded">,
  ended: (runId: string) => BoxEnded,
  logger: Pick<Logger, "info">,
  options: BoxPassOptions = {},
): Promise<string[]> {
  const finished = await workers.finishEnded(ended, options);
  if (finished.length > 0) logger.info("ended box runs checked and deleted", { finished });
  return finished;
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

/**
 * Removes the part stage folders this daemon left in its own folder of stages `stageRoot`
 * (`partStageRoot`, DIPO-290) when it stopped: a crash during a part leaves the box's files there.
 * Runs at daemon start, leaving the stages `parts` uses; another daemon's folder is never touched.
 * Never rejects.
 */
export async function sweepBoxPartStages(
  stageRoot: string,
  parts: Pick<BoxParts, "sweepStages"> | null,
  logger: Pick<Logger, "info">,
): Promise<number> {
  const removed = await (parts === null ? sweepPartStages(stageRoot) : parts.sweepStages());
  if (removed > 0) logger.info("removed part stage folders a stopped daemon left", { removed });
  return removed;
}

/**
 * The door's `onPart` of the daemon's box workers: the part is delivered (DIPO-273), then a
 * collision check runs, since the part may change the files the story changes (DIPO-277). A part
 * that was not delivered rejects, stays queued in the box and starts no check.
 */
export function deliverThenCheck(
  deliver: (part: DoorPart) => Promise<void>,
  check: () => void,
): (part: DoorPart) => Promise<void> {
  return async (part) => {
    await deliver(part);
    check();
  };
}

/**
 * The package cache of the daemon's box runs (DIPO-295): each office's root in dipo's state
 * folder, `<state>/PACKAGE_CACHE_DIR/<office>`; the lockfile is read from the base branch.
 */
export function boxPackageCache(stateDir: string): BoxPackageCacheDeps {
  return { root: (office) => officePackageCacheRoot(stateDir, office) };
}

/**
 * Records a push of a box run's story branch on its live claim in the run's office (DIPO-315):
 * every story-branch push dipo makes sets `claims.pushed_at` once it reaches the remote.
 */
function claimPushRecorder(options: DaemonRunsOptions): (run: PartRun, push: BranchPush) => void {
  return (run, push) => {
    const handle = options.offices.get(run.office);
    if (handle === undefined) return;
    handle.immediate(() => recordBranchPush(handle, run.branch, push, options.clock.now()));
  };
}

/**
 * The box workers of the daemon (DIPO-271) and the delivery of their parts (DIPO-273), or null
 * without a box backend. `parts` gives the run facts and run control the delivery needs.
 */
function daemonBoxWorkers(
  options: DaemonRunsOptions,
  tmpRoot: string,
  parts: Pick<BoxPartsDeps, "run" | "live" | "park" | "notice" | "behind">,
  afterPart: () => void = () => {},
): {
  readonly workers: BoxWorkers;
  readonly parts: BoxParts;
  readonly boxes: BoxPort;
} | null {
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
            // A box mounts only a package cache under dipo's own folder of caches (DIPO-295).
            packageCacheRoot: join(options.stateDir, PACKAGE_CACHE_DIR),
            // A box mounts only box network tools under dipo's own folder of them (DIPO-281).
            netToolsRoot: join(options.stateDir, BOX_NET_TOOLS_DIR),
          });
  }
  if (boxes === null) return null;
  const routeRoot = join(tmpRoot, "dipo-box-routes");
  const scratchRoot = join(tmpRoot, "dipo-box-builds");
  let routes = 0;
  // dipo's web route (Safe-Chain behind the web proxy) on the box network's host address, for the
  // boxes and the build boxes alike (DIPO-281).
  const startRoute = async (network: Pick<BoxNetwork, "hostAddress">) => {
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
  // Each part the door takes is delivered: taken out of the box, scanned, committed and pushed
  // (DIPO-273). The delivery reads the door before a story done, so `workers` is bound once made.
  let workers: BoxWorkers | null = null;
  const delivery = new BoxParts({
    boxes,
    clock,
    // This daemon's own folder of part stages, in its state folder, so no other daemon or user
    // shares it and a daemon start sweeps only its own (DIPO-290).
    stageRoot: partStageRoot(options.stateDir),
    ...(uid >= 0 ? { uid } : {}),
    ...parts,
    git: (office) => options.engineGit.forOffice(office),
    listedFiles: async (git) => {
      const base = await readBaseBox(git);
      return base.ok ? base.description.files.map((file) => file.path) : [];
    },
    readDoor: (runId) => workers?.readDoor(runId) ?? null,
    pushed: claimPushRecorder(options),
    warn: (message, fields) => options.logger.warn(message, fields),
    info: (message, fields) => options.logger.info(message, fields),
  });
  workers = new BoxWorkers({
    boxes,
    startWebRoute: startRoute,
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
    // The part queue of each box is read while its session runs (DIPO-272), and each part is
    // delivered (DIPO-273). No read starts once the run ended (DIPO-297).
    door: {
      onPart: deliverThenCheck((part) => delivery.onPart(part), afterPart),
      live: (runId) => parts.live(runId),
    },
    // After the install in a new box, its /work is compared with the start commit on dipo's own
    // copy, as a part is (DIPO-294).
    treeCheck: (run) => delivery.changedSinceStart(run),
    // Each box gets its office's package cache, filled or reused before it is made (DIPO-295).
    packageCache: boxPackageCache(options.stateDir),
    scratchRoot: (() => {
      ensurePrivateDir(scratchRoot);
      return scratchRoot;
    })(),
    netToolsRoot: join(options.stateDir, BOX_NET_TOOLS_DIR),
    warn: (message, fields) => options.logger.warn(message, fields),
    info: (message, fields) => options.logger.info(message, fields),
  });
  return { workers, parts: delivery, boxes };
}

/** Raises an `engine.notice` of a box run for the maintainer (DIPO-277, DIPO-290). */
function runNotice(
  options: DaemonRunsOptions,
): (
  office: OfficeId,
  runId: string,
  notice: { readonly level: "info" | "warn"; readonly code: string; readonly text: string },
) => void {
  return (office, runId, notice) => {
    const handle = options.offices.get(office);
    if (handle === undefined) return;
    const key = findRun(handle, runId as RunId)?.key ?? null;
    const at = options.clock.now();
    handle.immediate(() =>
      appendEntries(
        handle,
        [
          {
            type: "engine.notice",
            ...(key === null ? {} : { key }),
            run: runId as RunId,
            delta: notice,
          },
        ],
        { at },
      ),
    );
    options.onChanged(office);
  };
}

/**
 * The collision check of the box runs in progress (DIPO-277): their changed files compared, an
 * overlap told to the maintainer (an `engine.notice`) and to both workers, and the second story
 * caught up once the first merged. Null without a box backend.
 */
function boxCollisions(
  options: DaemonRunsOptions,
  boxed: ReturnType<typeof daemonBoxWorkers>,
  control: RunControl,
  partRun: ((runId: string) => PartRun | null) | null,
  conflicts: {
    readonly service: StoryConflicts | null;
    readonly isBoxRun: (office: OfficeId, run: StoredRun) => boolean;
    readonly unpark: UnparkWriter;
  },
): BoxCollisions | null {
  if (boxed === null) return null;
  const { clock } = options;
  const storedRun = (run: PartRun): StoredRun | null => {
    const handle = options.offices.get(run.office);
    return handle === undefined ? null : findRun(handle, run.runId as RunId);
  };
  const service = conflicts.service;
  return new BoxCollisions({
    boxes: boxed.boxes,
    code: { spawn: systemSpawn, clock },
    tmpRoot: realDir(options.tmpRoot),
    runs: () =>
      boxed.workers.pending().flatMap((runId) => {
        const run = partRun?.(runId) ?? null;
        return run === null ? [] : [run];
      }),
    git: (office) => options.engineGit.forOffice(office),
    live: (runId) => control.live(runId),
    parts: boxed.parts,
    park: (runId, park) => control.parkRun(runId, park),
    tell: (runId, text, source) => control.tellWorker(runId, text, source),
    notice: runNotice(options),
    pushed: claimPushRecorder(options),
    // Conflicts with the base (DIPO-149): the stories In Review checked, each merge recorded, a
    // task file resolved to the base's version gets the branch's status back, the item budget.
    inReview: () =>
      options.offices.loadedOffices().flatMap((office) => {
        const handle = options.offices.get(office);
        if (handle === undefined) return [];
        return inReviewRunIds(handle).flatMap((runId) => {
          const run = findRun(handle, runId);
          const part = run === null ? null : (partRun?.(runId) ?? null);
          return run !== null && part !== null && conflicts.isBoxRun(office, run) ? [part] : [];
        });
      }),
    ...(service === null
      ? {}
      : {
          recorded: (run: PartRun, merged: Parameters<StoryConflicts["recorded"]>[1]) =>
            service.recorded(run, merged),
          found: (run: PartRun, found: Parameters<StoryConflicts["found"]>[1]) =>
            service.found(run, found),
          cleared: (run: PartRun) => service.cleared(run),
        }),
    // A catch-up that changed a lockfile installs the office's packages in the box again, as the
    // launch does before the worker (DIPO-294); a failure is the catch-up's warning only.
    reinstall: async (run) => {
      const stored = storedRun(run);
      const config = options.offices.config(run.office);
      const handle = options.offices.get(run.office);
      const profile = handle === undefined ? null : (currentProfile(handle)?.profile ?? null);
      if (stored === null || config === undefined || profile === null) {
        throw new Error(`run ${run.runId} has no run profile to install with`);
      }
      const install = boxInstallInput({
        profile,
        config,
        story: run.story,
        slot: stored.slot,
      });
      if (install === null) return;
      if ("refused" in install) throw new Error(install.refused);
      const installed = await boxed.workers.install({ runId: run.runId, ...install });
      if (!installed.ok) throw new Error(installed.reason);
    },
    taskStatus: async (run, status) => {
      const stored = storedRun(run);
      if (stored === null || stored.worktree === null) {
        throw new Error(`run ${run.runId} has no worktree to write its task file from`);
      }
      const lifted = await conflicts.unpark.lift(run.office, {
        story: run.story,
        branch: run.branch,
        worktree: stored.worktree,
        to: Lifecycle.parse(status),
      });
      claimPushRecorder(options)(run, { pushed: lifted.pushed, error: lifted.pushError });
    },
    itemMax: (run) => {
      const config = options.offices.config(run.office);
      if (config === undefined) return 3_000;
      const budgets = config.prompt.budgets.feedbackItem as Readonly<Record<string, number>>;
      const tier = storedRun(run)?.tier ?? null;
      return (tier === null ? undefined : budgets[tier]) ?? config.prompt.budgets.feedbackItem.M;
    },
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

/** Why a part is refused while the box lacks a merge dipo made outside it (DIPO-324). */
export const BOX_BEHIND_TEXT =
  "dipo merged the base into the story branch outside the box, and the box has not received that merge, so a part now would undo it; resume the story to copy the merge into the box first";

/**
 * The parts' `behind` check (DIPO-324): why the run's box lacks a merge dipo committed on its
 * branch outside the box, or null when it holds them all. Fails closed: a run whose office is not
 * loaded here is behind, since dipo cannot tell.
 */
export function boxBehind(offices: {
  get(office: OfficeId): OfficeHandle | undefined;
}): (run: PartRun) => string | null {
  return (run) => {
    const handle = offices.get(run.office);
    if (handle === undefined) {
      return `dipo cannot read the office of ${run.story} here, so it cannot tell whether the box holds every merge dipo made on the branch; no part is taken until it can`;
    }
    return pendingBoxCopy(handle, run.runId) === null ? null : BOX_BEHIND_TEXT;
  };
}

/**
 * The merge a resumed conflict park needs in its live run's box (DIPO-324,
 * `BoxCollisions.mergeOnResume`). The worker was told dipo merges, so a merge dipo cannot make
 * here is never silent: it is a park of the live run with what went wrong, and a warning.
 */
export function conflictMergeOf(deps: {
  readonly run: (runId: string) => PartRun | null;
  readonly collisions: () => BoxCollisions | null;
  readonly warn: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}): (office: OfficeId, runId: RunId) => Promise<SyncOutcome> {
  return async (office, runId) => {
    const run = deps.run(runId);
    const collisions = deps.collisions();
    if (run !== null && collisions !== null && run.office === office) {
      return collisions.mergeOnResume(run);
    }
    const why =
      run === null || run.office !== office
        ? `dipo does not know the box of run ${runId} here`
        : "this daemon has no box collisions to merge with";
    deps.warn("the merge a conflict resume promised cannot run", { office, run: runId, why });
    return {
      kind: "park",
      park: {
        reason: "conflict",
        detail: `dipo resumed the story to merge the base into its branch and box once the session ran, but ${why}, so nothing was merged; resume it again`,
      },
    };
  };
}

/** How often the daemon passes over the boxes besides each exit decision (DIPO-278). */
export const BOX_PASS_TICK_MS = 60_000;

/** The run launcher `work.run` starts workers with. */
export function daemonRuns(options: DaemonRunsOptions): DaemonRuns {
  const { clock, platform, env, home, uid } = options;
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
  // A part needs the run's facts and run control, both made further down (DIPO-273).
  let runControl: RunControl | null = null;
  let partRun: ((runId: string) => PartRun | null) | null = null;
  // The changed files of the box runs in progress, compared after each part (DIPO-277).
  let collisions: BoxCollisions | null = null;
  const boxed = daemonBoxWorkers(
    options,
    realDir(options.tmpRoot),
    {
      run: (runId) => partRun?.(runId) ?? null,
      live: (runId) => runControl?.live(runId) === true,
      park: (runId, park) => runControl?.parkRun(runId, park) === true,
      // A part dipo keeps failing to take out of the box is told, never parked (DIPO-290).
      notice: (run, notice) => runNotice(options)(run.office, run.runId, notice),
      // No part is taken while the box lacks a merge the merge slot made (DIPO-324).
      behind: boxBehind(options.offices),
    },
    () => void collisions?.check(),
  );
  const boxWorkers = boxed?.workers ?? null;
  void sweepBoxTokenChecks(realDir(options.tmpRoot), options.logger).catch(() => {});
  void sweepBoxPartStages(partStageRoot(options.stateDir), boxed?.parts ?? null, options.logger);
  const finishEndedBoxes = async (
    finishOptions: { readonly listBoxes?: boolean } = {},
  ): Promise<void> => {
    if (boxWorkers === null) return;
    await finishEndedBoxRuns(
      boxWorkers,
      (runId) => boxRunEnded(options.offices, runId),
      options.logger,
      // A listed box the index lost gets its entry again from the office that knows its run.
      { ...finishOptions, runDirOf: (runId) => runDirOfRun(runId) },
    );
  };
  // A drop or a merge ends a claim with no worker exit, so a minute tick also runs the pass: the
  // box of a released claim is deleted within about a minute (DIPO-278).
  let boxTick: ReturnType<typeof clock.setTimeout> | null = null;
  let boxTicks = boxWorkers !== null;
  const armBoxTick = (): void => {
    if (!boxTicks) return;
    boxTick = clock.setTimeout(() => {
      boxTick = null;
      void finishEndedBoxes().finally(armBoxTick);
    }, BOX_PASS_TICK_MS);
  };
  armBoxTick();
  const stopBoxPasses = (): void => {
    boxTicks = false;
    if (boxTick !== null) clock.clearTimeout(boxTick);
    boxTick = null;
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
  // Safe-Chain proxy directories a killed daemon left behind (a box web route's) go first; a
  // running daemon's stay.
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
  const claude = claudeWorkerPort({
    spawn: systemSpawn,
    clock,
    claudePath: options.tools.claude,
    home,
    env,
    holds: options.holds,
    // A reviewer's run settings hooks run this binary (DIPO-59).
    dipoCommand: selfCommand(),
    ...(boxWorkers === null ? {} : { boxes: boxWorkers }),
  });
  const worker = options.workerPort === undefined ? claude : options.workerPort(claude);
  const tierOf = (office: OfficeId, run: StoredRun) =>
    run.tier === null
      ? undefined
      : options.offices.config(office)?.tiers[run.tier as "S" | "M" | "L"];
  const storyGit = gitStoryOps({
    git: (office) => options.engineGit.forOffice(office),
    cli: options.cli,
  });
  // Whether a run's developer works in a box: its run directory says so (DIPO-271).
  // It reads `runPaths` only when asked, after the launcher's wiring below exists.
  const isBoxRun = (office: OfficeId, run: StoredRun): boolean => {
    const paths = boxed === null ? null : runPaths(office, run);
    return paths !== null && boxed !== null && boxed.workers.isBoxRun(paths.runDir);
  };
  // Conflicts with the base before In Review and the conflict hand-off of box runs (DIPO-149): the
  // sync runs in the run's held turn through the collision service made below.
  const storyConflicts =
    boxed === null
      ? null
      : new StoryConflicts({
          clock,
          ids: options.ids,
          offices: options.offices,
          git: (office) => options.engineGit.forOffice(office),
          sync: async (runId, mode) => {
            const run = partRun?.(runId) ?? null;
            if (run === null || collisions === null) return { kind: "none" };
            return collisions.syncInTurn(run, mode);
          },
          onChanged: options.onChanged,
          warn: (message, fields) => options.logger.warn(message, fields),
        });
  // In Review at a box run's done (DIPO-49, DIPO-273): no verify, backstop or scope check of dipo's.
  const finisher = new VerifyCommit({
    clock,
    story: storyGit,
    profile: (office) => currentProfile(office)?.profile ?? null,
    ...(options.storyPr === undefined ? {} : { storyPr: options.storyPr }),
    // The report gate reads the story's test plan on the office base (DIPO-186).
    storyFacts: baseStoryFacts(options.base),
    // A box run has no backstop, scope check or verify of dipo's (DIPO-273, DIPO-299): its last
    // part is taken at done and its end claimed while its parts are held; CI is its verify.
    ...(boxed === null
      ? {}
      : {
          parts: {
            isBoxRun,
            finishLast: (runId, message, finish) => boxed.parts.finishLast(runId, message, finish),
          },
          ...(storyConflicts === null ? {} : { conflicts: storyConflicts }),
        }),
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  const started = systemHostStarter({
    clock,
    runtimeDir: options.runtimeDir,
    dipoCommand: selfCommand(),
    env,
    probe,
  });
  const hosts = started;
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
  // The run directory of a run a loaded office knows (DIPO-278: an index entry written again).
  const runDirOfRun = (runId: string): string | null => {
    for (const office of options.offices.loadedOffices()) {
      const handle = options.offices.get(office);
      const run = handle === undefined ? null : findRun(handle, runId as RunId);
      if (run === null) continue;
      return runPaths(office, run)?.runDir ?? null;
    }
    return null;
  };
  // The facts of a box run a part needs (DIPO-273), from the loaded office that knows the run.
  partRun = (runId) => {
    for (const office of options.offices.loadedOffices()) {
      const handle = options.offices.get(office);
      const run = handle === undefined ? null : findRun(handle, runId as RunId);
      if (run === null) continue;
      if (run.story === null || run.branch === null || run.startSha === null) return null;
      const paths = runPaths(office, run);
      return {
        runId,
        office,
        story: run.story,
        branch: run.branch,
        startSha: run.startSha,
        box: boxName(runId),
        ...(paths === null ? {} : { runDir: paths.runDir }),
      };
    }
    return null;
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
    ...(options.slotReentry === undefined ? {} : { slotReentry: options.slotReentry }),
    // A resumed conflict park merges in its live run's box (DIPO-324), and a story resumed to wait
    // In Review again gets a new story PR when its PR was closed (0002).
    conflictMerge: conflictMergeOf({
      run: (runId) => partRun?.(runId) ?? null,
      collisions: () => collisions,
      warn: (message, fields) => options.logger.warn(message, fields),
    }),
    ...(options.storyPr?.replace === undefined
      ? {}
      : {
          prReplacement: () => ({
            replace: (office: OfficeId, run: StoredRun) =>
              options.storyPr?.replace?.(office, run.runId) ?? Promise.resolve(),
          }),
        }),
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
    // The box network's host address, live, for the web guard and each reviewer's web proxy.
    ...(boxWorkers === null ? {} : { boxHostAddress: () => boxWorkers.hostAddress }),
    // The merges the merge slot made on a box run's branch reach its box before the worker's next
    // session (DIPO-324): the box is started, the files copied in as a catch-up's are.
    boxSync: async (office, run) => {
      const handle = options.offices.get(office);
      const pending = handle === undefined ? null : pendingBoxCopy(handle, run.runId);
      if (handle === undefined || pending === null) return;
      const part = partRun?.(run.runId) ?? null;
      if (
        part === null ||
        part.runDir === undefined ||
        boxWorkers === null ||
        collisions === null
      ) {
        throw new Error(`run ${run.runId} has no box dipo can copy into here`);
      }
      await boxWorkers.awake({ runId: run.runId, runDir: part.runDir });
      await collisions.copyPending(part, pending.from);
      handle.immediate(() => markBoxCopied(handle, run.runId, pending.ids));
    },
    // A fix round waits for the CI of the pushed head and carries its red items (DIPO-148); a box
    // run's developer gets a new session in its box (0021 section 6).
    ...(options.storyPr?.ciState === undefined
      ? {}
      : {
          ci: (office: OfficeId, runId: RunId) => options.storyPr?.ciState?.(office, runId) ?? null,
        }),
    boxRun: isBoxRun,
    // The permission wait (DIPO-59) asks the maintainer when present, and holds while `safe`.
    ...(options.presence === undefined ? {} : { presence: options.presence }),
    ...(options.scheduling === undefined ? {} : { scheduling: options.scheduling }),
    ingest: {
      pricing: () => options.database()?.pricing ?? null,
      watchdog,
      onEnded: () => {
        // A run that ended before its worker exited loses its temp directory now (DIPO-102).
        sweepTempDirs();
        void finishEndedBoxes();
      },
    },
    control: {
      finisher,
      // The park written on the story branch (DIPO-50).
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
      // Lifting a park on the story branch before its run resumes (DIPO-75).
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
    // DIPO-39's worktree setup of a claimed story (slot, run environment, files), before its box.
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
          slots: options.slots,
          localSettings: worker.localSettings,
        },
        { claim, config, profile: currentProfile(handle)?.profile ?? null },
      );
    },
    // Re-attach after a restart (DIPO-57): every active run's newest worker host is followed again.
    reattach: {
      probe,
      // A living host of an ended run whose stop did not reach it is stopped again (DIPO-93).
      steering,
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
  runControl = control;
  // Each head whose CI stops being pending may start its fix round (DIPO-148).
  const fixRounds = composed.fixRounds;
  options.storyPr?.onCiFinal?.((office, runId) => {
    void fixRounds?.consider(office, runId);
  });
  collisions = boxCollisions(options, boxed, control, partRun, {
    service: storyConflicts,
    isBoxRun,
    unpark: gitUnparkWriter({
      git: (office) => options.engineGit.forOffice(office),
      cli: options.cli,
    }),
  });
  collisions?.start();
  return {
    sessions: composed.sessions,
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
    tempDirs,
    boxes: boxWorkers,
    isBoxRun,
    collisions,
    finishEndedBoxes,
    stopBoxPasses,
    recoverFixRounds: async () => {
      let queued = 0;
      for (const office of options.offices.loadedOffices()) {
        queued += (await fixRounds?.recover(office)) ?? 0;
      }
      return queued;
    },
    sweepReviewFolders: () =>
      sweepReviewFolders(realDir(options.tmpRoot), (runId, agent) =>
        reviewHostRuns(options.offices, runId, agent),
      ),
    // The merge slot's ports (DIPO-150): its conflicts and the maintainer's rejects go through the
    // fix rounds, and its merges are recorded as DIPO-149's catch-ups are.
    mergeSlot: {
      conflict: async (office, runId, input) =>
        (await fixRounds?.conflict(office, runId, input)) ?? false,
      reject: async (office, runId, reject) =>
        (await fixRounds?.reject(office, runId, reject)) ?? false,
      recordMerge: async (office, run, merged) => {
        if (storyConflicts === null || run.story === null || run.branch === null) return;
        await storyConflicts.recorded(
          {
            runId: run.runId,
            office,
            story: run.story,
            branch: run.branch,
            startSha: run.startSha ?? "",
            box: boxName(run.runId),
          },
          merged,
          // A carry that fails throws: the slot merges nothing on that head (DIPO-150).
          { strict: true },
        );
      },
      story: baseStoryFacts(options.base),
      itemMax: (office, run) => {
        const config = options.offices.config(office);
        if (config === undefined) return 3_000;
        const budgets = config.prompt.budgets.feedbackItem as Readonly<Record<string, number>>;
        return (
          (run.tier === null ? undefined : budgets[run.tier]) ??
          config.prompt.budgets.feedbackItem.M
        );
      },
    },
  };
}
