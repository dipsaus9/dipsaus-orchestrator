// The worker start of claimed runs in the engine (DIPO-74): the run launcher with the Claude CLI
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
// Each review session runs in a reviewer box of its own, made and deleted by the box workers (0002).

import { rmSync } from "node:fs";
import { join } from "node:path";

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
import type { BacklogCli } from "../backlog/runner";
import { AppleContainerBoxes } from "../box/apple-container";
import { PACKAGE_CACHE_DIR } from "../box/cache";
import { BoxCollisions } from "../box/collisions";
import { BOX_NET_TOOLS_DIR } from "../box/firewall";
import { readBaseBox } from "../box/image";
import { boxInstallInput, boxVerifyInput } from "../box/lifetime";
import { startModelProxy, type ListenHttp } from "../box/model-proxy";
import { BoxParts, partStageRoot, type BoxPartsDeps, type PartRun } from "../box/parts";
import { boxName, type BoxNetwork, type BoxPort, stateFolderLabel } from "../box/port";
import { startBoxWebRoute } from "../box/safe-chain-box";
import { TestBoxes, type TestBoxesDeps } from "../box/test-box";
import {
  BOX_INDEX_DIR,
  type BoxSafeChainStore,
  BoxWorkers,
  type RouteBoxIds,
} from "../box/workers";
import { appendEntries } from "../changelog/log";
import type { StateDatabase } from "../db/database";
import type { EngineGit } from "../git/feature";
import { PermissionAsks } from "../questions/permissions";
import type { IngestAdapter } from "../ingest/ingestor";
import type { Logger } from "../log/logger";
import type { MergeGatesDeps } from "../merge/commands";
import { guardedParkWriter, guardedUnparkWriter, type AutoMergeGuard } from "../merge/guard";
import type { StoryMergeDeps } from "../merge/stories";
import type { OfficeManager } from "../office/manager";
import { ensurePrivateDir } from "../platform/paths";
import { safeChainFeedback } from "../prompts/feedback";
import { signalProcess, systemSpawn, type ProcessProbe } from "../platform/process";
import { runCaps } from "../run/caps";
import {
  boxBehind,
  boxPackageCache,
  boxRunEnded,
  conflictMergeOf,
  containerOnPath,
  deliverThenCheck,
  finishEndedBoxRuns,
  realDir,
  sweepBoxPartStages,
  sweepBoxTokenChecks,
} from "../run/box-runs";
import { composeRuns, type ComposedRuns, type RunPorts } from "../run/compose";
import { startedSessionState } from "../run/started-session";
import type { RunSteering } from "../run/control";
import { Partner } from "../wiring/partner";
import type { Caps } from "../workers/types";
import { inReviewRunIds, markBoxCopied, pendingBoxCopy, StoryConflicts } from "../run/conflicts";
import { RunControl } from "../run/control";
import { hostSocketSteering, OfficeIngest } from "../run/hosts";
import {
  capsOf,
  RunLauncher,
  runLaunchPaths,
  type HostStarter,
  type TierCaps,
} from "../run/launch";
import type { Presence } from "../run/live-question";
import { storyHoldsWork } from "../run/outcome-types";
import { RunOutcomes } from "../run/outcomes";
import { gitParkWriter, gitUnparkWriter, type UnparkWriter, type ParkWriter } from "../run/park";
import type { MergeReentry } from "../run/park-resume";
import type { Places } from "../run/places";
import { RunReattacher } from "../run/reattach";
import { sendFeedback } from "../run/feedback";
import { findRun, recordSafeChain, type StoredRun } from "../run/records";
import { baseStoryFacts } from "../run/resume";
import type { Resumption } from "../run/resumption";
import { sweepOldReviewFolders } from "../run/review-launch";
import type { StartsPaused } from "../run/starts-paused";
import { gitStoryOps } from "../run/story-git";
import { RunTempDirs } from "../run/temp-dirs";
import type { StoryTestsDeps } from "../run/tests";
import { VerifyCommit } from "../run/verify-commit";
import { Watchdog } from "../run/watchdog";
import type { HoldResumer } from "../run/work-resume";
import type { RunBase } from "../run/work-run";
import type { ScanSessionRunner } from "../scan/fallback";
import { currentProfile } from "../scan/store";
import type { StoryIndex } from "../stories/feature";
import type { CiHeadState } from "../story-pr/prs";
import { recordBranchPush, type BranchPush } from "../story-pr/records";
import type { StoryStore } from "../story-store/store";
import { claudeWorkerPort } from "../workers/claude-cli/adapter";
import { CLAUDE_CLI_ADAPTER_ID } from "../workers/claude-cli/plan";
import type { AdapterHolds } from "../workers/hold";
import type { WorkerPort } from "../workers/port";
import type { StoryClaims } from "../worktree/feature";

/**
 * The Backlog CLI at the absolute path the daemon resolved, else `backlog` on `PATH` (AC #8). The
 * runner gives each call only `PATH` and `HOME` of the daemon's environment (`backlogEnv`), and a
 * story's calls run in dipo's own copy of its backlog, never its worktree (0021 section 14).
 */
export function backlogCliFor(tools: ToolPaths, spawn: Spawn = systemSpawn): BacklogCli {
  return tools.backlog === undefined ? { spawn } : { spawn, command: [tools.backlog] };
}

export interface RunsOptions {
  readonly tools: ToolPaths;
  /** Reads a process's start time: whether a worker host still runs (DIPO-57). */
  readonly probe: ProcessProbe;
  /** Starts the processes of the runs: boxes, the Keychain, the worker. */
  readonly spawn: Spawn;
  /** Starts the detached worker hosts (0006 decision 8). */
  readonly hosts: HostStarter;
  /** The test boxes' forwarders on the Mac's loopback, and the check that one answers (DIPO-309). */
  readonly forwarders: Pick<TestBoxesDeps, "forward" | "reach">;
  /** The model proxy's HTTP listener on the box network (0008). */
  readonly listenHttp: ListenHttp;
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
  readonly base: RunBase;
  readonly database: () => StateDatabase | null;
  readonly onChanged: (office: OfficeId) => void;
  readonly logger: Logger;
  /** The story store the park commit and the steps at done run through (DIPO-50, 0010). */
  readonly storyStore: StoryStore;
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
  /** The auto-merge a story waiting In Review again goes back to after a resume (0002). */
  readonly mergeReentry?: () => MergeReentry | undefined;
  /**
   * Turns auto-merge off for a story branch's PR before a park or a lift is written to the branch
   * (0002); the write throws when it cannot. Without it the writers are not guarded (tests).
   */
  readonly autoMergeGuard?: AutoMergeGuard;
  /** The story index, which reads a story again after its park or In Review commit (DIPO-56). */
  readonly stories?: StoryIndex;
  /** Whether a TUI is connected, for live questions (DIPO-279); none by default. */
  readonly presence?: Presence;
  /** False while the daemon schedules no work (recovering, draining): a starts paused lifts later (0020). */
  readonly scheduling?: () => boolean;
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

export interface EngineRuns {
  readonly launcher: RunLauncher;
  readonly ingest: OfficeIngest;
  /** Caps, report parks and `story.park` of a story with a run (DIPO-50). */
  readonly control: RunControl;
  /** Worker outcomes and the run's next session (DIPO-51); its feature decides exits at load. */
  readonly outcomes: RunOutcomes;
  /**
   * Park resume and `work.resume` (DIPO-138): `work.answer` on an `ambiguous-spec` park resumes
   * through it, and its feature registers `work.resume`.
   */
  readonly resumption: Resumption;
  /** The permission wait and `work.answer` (DIPO-59). */
  readonly permissions: PermissionAsks;
  /** Re-attach of worker hosts after a restart (DIPO-57), a recovery step after reconcile. */
  readonly reattacher: RunReattacher;
  /**
   * The office's starts paused (0020): a plan limit pauses every loaded office until its reset,
   * then resumes the parks it made; a failed adapter check pauses through the adapter's hold.
   */
  readonly startsPaused: StartsPaused;
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
  /** The test boxes (DIPO-309); null without a box backend. */
  readonly testBoxes: TestBoxes | null;
  /** Runs `hook` after each pass of the box minute tick (DIPO-309: the test sweep). */
  onBoxTick(hook: () => Promise<void>): void;
  /**
   * The fix rounds' recovery (DIPO-148), at daemon start: a round whose session started before the
   * stop is marked delivered, and every run open at In Review past its review gets its round decided. Returns how
   * many rounds it queued.
   */
  recoverFixRounds(): Promise<number>;
  /**
   * Removes the read-only reviewer folders an earlier binary left in the temp root (DIPO-347), at
   * daemon start by the recovery step. Never rejects.
   */
  sweepOldReviewFolders(): Promise<string[]>;
  /**
   * The auto-merge's ports into the run services (0002): a conflict merge dipo committed is
   * recorded and goes to the worker as one fix round, a maintainer reject as another, and the
   * story's facts on the base are read as the review loop reads them.
   */
  readonly merge: RunMergePorts;
  /** The scan fallback's `session` runs (DIPO-310), which `office.infer` starts. */
  readonly sessions: ScanSessionRunner;
}

/** What the auto-merge and the merge gates use of the run services (0002). */
export interface RunMergePorts {
  readonly conflict: NonNullable<StoryMergeDeps["conflict"]>;
  readonly reject: NonNullable<MergeGatesDeps["reject"]>;
  /** A failed test's note to the same builder (DIPO-309). */
  readonly testFail: NonNullable<StoryTestsDeps["testFail"]>;
  readonly recordMerge: NonNullable<StoryMergeDeps["recordMerge"]>;
  readonly story: NonNullable<StoryMergeDeps["story"]>;
  readonly itemMax: NonNullable<StoryMergeDeps["itemMax"]>;
}

/**
 * Records a push of a box run's story branch on its live claim in the run's office (DIPO-315):
 * every story-branch push dipo makes sets `claims.pushed_at` once it reaches the remote.
 */
function claimPushRecorder(options: RunsOptions): (run: PartRun, push: BranchPush) => void {
  return (run, push) => {
    const handle = options.offices.get(run.office);
    if (handle === undefined) return;
    handle.immediate(() => recordBranchPush(handle, run.branch, push, options.clock.now()));
  };
}

/**
 * The run services that call a service built after them (DIPO-318), connected once in
 * `connectRunsPartners`; a call before that throws.
 */
interface RunsPartners {
  readonly control: Partner<RunControl>;
  readonly collisions: Partner<BoxCollisions | null>;
  readonly workers: Partner<BoxWorkers>;
}

/** The box workers, the delivery of their parts and the backend, or null without a backend. */
interface BoxedRuns {
  readonly workers: BoxWorkers;
  readonly parts: BoxParts;
  readonly boxes: BoxPort;
}

/**
 * The box backend (DIPO-271): the one given, else Apple `container` when the daemon's PATH has it,
 * else none.
 */
function boxBackend(options: RunsOptions): BoxPort | null {
  if (options.boxes !== undefined) return options.boxes;
  const cli = containerOnPath(options.env["PATH"]);
  if (cli === undefined) return null;
  return new AppleContainerBoxes({
    spawn: options.spawn,
    clock: options.clock,
    cli,
    // The `container` client's own environment; a box never inherits it.
    env: { PATH: options.env["PATH"] ?? "/usr/bin:/bin", HOME: options.home },
    // A box mounts only a package cache under dipo's own folder of caches (DIPO-295).
    packageCacheRoot: join(options.stateDir, PACKAGE_CACHE_DIR),
    // A box mounts only box network tools under dipo's own folder of them (DIPO-281).
    netToolsRoot: join(options.stateDir, BOX_NET_TOOLS_DIR),
    // Every box names this state folder, so a daemon-start sweep deletes only its own (DIPO-374).
    stateLabel: stateFolderLabel(options.stateDir),
  });
}

/**
 * dipo's web route on the box network's host address, with Safe-Chain in a box of its own behind
 * it (DIPO-343), for the boxes, the build boxes and the fill boxes alike (DIPO-281).
 */
function boxRouteStarter(
  options: RunsOptions,
  tmpRoot: string,
  backend: BoxPort,
): ConstructorParameters<typeof BoxWorkers>[0]["startWebRoute"] {
  const { clock } = options;
  const routeRoot = join(tmpRoot, "dipo-box-routes");
  const scratchRoot = join(tmpRoot, "dipo-box-builds");
  let routes = 0;
  return async (network: BoxNetwork, ids: RouteBoxIds) => {
    ensurePrivateDir(routeRoot);
    ensurePrivateDir(scratchRoot);
    routes += 1;
    const dir = join(routeRoot, `route-${routes}`);
    const started = await startBoxWebRoute(
      network,
      {
        boxes: backend,
        clock,
        scratchRoot,
        toolsRoot: join(options.stateDir, BOX_NET_TOOLS_DIR),
        caFile: join(dir, "ca.pem"),
        boxId: ids.boxId,
        buildId: ids.buildId,
        onEvent: (event) =>
          options.logger.warn("a Safe-Chain image build box was not cleaned up", {
            box: event.box,
            step: event.step,
            reason: event.reason,
          }),
        onRoute: (event) =>
          options.logger.warn(
            event.kind === "safeChainEnded"
              ? "Safe-Chain stopped in its box; registry installs fail until the web route starts again"
              : "the Safe-Chain box could not be deleted",
            { ...event },
          ),
      },
      { clock },
    );
    if (!started.ok) {
      rmSync(dir, { recursive: true, force: true });
      return started;
    }
    const route = started.route;
    const stop = async () => {
      try {
        await route.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    return { ok: true as const, route: { ...route, stop } };
  };
}

/**
 * The delivery of the parts the door takes (DIPO-273): taken out of the box, scanned, committed and
 * pushed. It reads the door before a story's done through the box workers, its partner.
 */
function boxPartsOf(
  options: RunsOptions,
  backend: BoxPort,
  parts: Pick<BoxPartsDeps, "run" | "live" | "park" | "notice" | "behind">,
  workers: Partner<BoxWorkers>,
): BoxParts {
  return new BoxParts({
    boxes: backend,
    clock: options.clock,
    stories: options.storyStore,
    // This daemon's own folder of part stages, in its state folder, so no other daemon or user
    // shares it and a daemon start sweeps only its own (DIPO-290).
    stageRoot: partStageRoot(options.stateDir),
    ...(options.uid >= 0 ? { uid: options.uid } : {}),
    ...parts,
    git: (office) => options.engineGit.forOffice(office),
    listedFiles: async (git) => {
      const base = await readBaseBox(git);
      return base.ok ? base.description.files.map((file) => file.path) : [];
    },
    readDoor: (runId) => workers.get().readDoor(runId),
    pushed: claimPushRecorder(options),
    warn: (message, fields) => options.logger.warn(message, fields),
    info: (message, fields) => options.logger.info(message, fields),
  });
}

/**
 * The box workers of the engine (DIPO-271) and the delivery of their parts (DIPO-273), or null
 * without a box backend. `parts` gives the run facts and run control the delivery needs; after each
 * delivered part the box collisions, a partner, run their check (DIPO-277).
 */
function engineBoxWorkers(
  options: RunsOptions,
  tmpRoot: string,
  parts: Pick<BoxPartsDeps, "run" | "live" | "park" | "notice" | "behind">,
  partners: RunsPartners,
): BoxedRuns | null {
  const backend = boxBackend(options);
  if (backend === null) return null;
  const { clock, home } = options;
  const scratchRoot = join(tmpRoot, "dipo-box-builds");
  const delivery = boxPartsOf(options, backend, parts, partners.workers);
  const workers = new BoxWorkers({
    boxes: backend,
    startWebRoute: boxRouteStarter(options, tmpRoot, backend),
    startModelProxy: (network) =>
      startModelProxy({
        network,
        keychain: { spawn: options.spawn, clock, env: { PATH: "/usr/bin:/bin", HOME: home } },
        listen: options.listenHttp,
        log: (line) => options.logger.debug("model proxy", { line }),
      }),
    readBaseBox: (git) => readBaseBox(git),
    code: { spawn: options.spawn, clock },
    holds: options.holds,
    adapter: CLAUDE_CLI_ADAPTER_ID,
    tmpRoot,
    indexDir: join(options.stateDir, BOX_INDEX_DIR),
    // The part queue of each box is read while its session runs (DIPO-272), and each part is
    // delivered (DIPO-273). No read starts once the run ended (DIPO-297).
    door: {
      onPart: deliverThenCheck(
        (part) => delivery.onPart(part),
        () => void partners.collisions.get()?.check(),
      ),
      live: (runId) => parts.live(runId),
    },
    // After the install in a new box, its /work is compared with the start commit on dipo's own
    // copy, as a part is (DIPO-294).
    treeCheck: (run) => delivery.changedSinceStart(run),
    // Each box gets its office's package cache, filled or reused before it is made (DIPO-295).
    packageCache: boxPackageCache(options.stateDir),
    // What Safe-Chain refused in each session is kept on its run, for its next session and its
    // reviewer (DIPO-376).
    safeChain: safeChainStoreOf(options),
    scratchRoot: (() => {
      ensurePrivateDir(scratchRoot);
      return scratchRoot;
    })(),
    netToolsRoot: join(options.stateDir, BOX_NET_TOOLS_DIR),
    warn: (message, fields) => options.logger.warn(message, fields),
    info: (message, fields) => options.logger.info(message, fields),
  });
  return { workers, parts: delivery, boxes: backend };
}

/**
 * Each run's Safe-Chain record in its office (DIPO-376): kept on the run row, and what a session's
 * read found held for the run's next developer session through the one feedback path, in one
 * transaction.
 */
export function safeChainStoreOf(
  options: Pick<RunsOptions, "offices" | "clock">,
): BoxSafeChainStore {
  return {
    of: (runId) => loadedRun(options, runId)?.run.safeChain ?? null,
    store: (runId, record, found) => {
      const loaded = loadedRun(options, runId);
      const handle = loaded === null ? undefined : options.offices.get(loaded.office);
      if (loaded === null || handle === undefined) return;
      const text = safeChainFeedback(found);
      const at = options.clock.now();
      handle.immediate(() => {
        recordSafeChain(handle, loaded.run.runId, record);
        if (text !== null)
          sendFeedback(handle, loaded.run.runId, { source: "safe-chain", text }, { at });
      });
    },
  };
}

/** Raises an `engine.notice` of a box run for the maintainer (DIPO-277, DIPO-290). */
function runNotice(
  options: RunsOptions,
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
  options: RunsOptions,
  boxed: BoxedRuns | null,
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
    stories: options.storyStore,
    code: { spawn: options.spawn, clock },
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
        return inReviewRunIds(options.storyStore, handle).flatMap((runId) => {
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
      const install = boxInstallInput({ profile, config });
      if (install === null) return;
      if ("refused" in install) throw new Error(install.refused);
      const installed = await boxed.workers.install({ runId: run.runId, ...install });
      if (!installed.ok) throw new Error(installed.reason);
    },
    taskStatus: async (run, status) => {
      const lifted = await conflicts.unpark.lift(run.office, {
        story: run.story,
        branch: run.branch,
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

/** How often the engine passes over the boxes besides each exit decision (DIPO-278). */
export const BOX_PASS_TICK_MS = 60_000;

/** Where a run's files are, and the facts of a box run its parts need (DIPO-273). */
interface RunPaths {
  readonly runPaths: (office: OfficeId, run: StoredRun) => ReturnType<typeof runLaunchPaths> | null;
  /** The run directory of a run a loaded office knows (DIPO-278: an index entry written again). */
  readonly runDirOfRun: (runId: string) => string | null;
  /** The facts of a box run a part needs (DIPO-273), from the loaded office that knows the run. */
  readonly partRun: (runId: string) => PartRun | null;
}

/** The loaded office that knows `runId`, with the run; null when none does. */
function loadedRun(
  options: Pick<RunsOptions, "offices">,
  runId: string,
): { readonly office: OfficeId; readonly run: StoredRun } | null {
  for (const office of options.offices.loadedOffices()) {
    const handle = options.offices.get(office);
    const run = handle === undefined ? null : findRun(handle, runId as RunId);
    if (run !== null) return { office, run };
  }
  return null;
}

function runPathsOf(options: RunsOptions, tmpRoot: string): RunPaths {
  const runPaths = (office: OfficeId, run: StoredRun) => {
    const git = options.engineGit.forOffice(office);
    if (git === undefined) return null;
    return runLaunchPaths(git, { runtimeDir: options.runtimeDir, tmpRoot }, run.runId);
  };
  return {
    runPaths,
    runDirOfRun: (runId) => {
      const found = loadedRun(options, runId);
      return found === null ? null : (runPaths(found.office, found.run)?.runDir ?? null);
    },
    partRun: (runId) => {
      const found = loadedRun(options, runId);
      if (found === null) return null;
      const { office, run } = found;
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
    },
  };
}

/** The passes over the boxes (DIPO-278), the test boxes (DIPO-309) and their tick. */
interface BoxPasses {
  readonly finishEndedBoxes: (finishOptions?: { readonly listBoxes?: boolean }) => Promise<void>;
  readonly stopBoxPasses: () => void;
  readonly testBoxes: TestBoxes | null;
  readonly onBoxTick: (hook: () => Promise<void>) => void;
}

function boxPassesOf(options: RunsOptions, boxed: BoxedRuns | null, paths: RunPaths): BoxPasses {
  const { clock } = options;
  const boxWorkers = boxed?.workers ?? null;
  const finishEndedBoxes = async (
    finishOptions: { readonly listBoxes?: boolean } = {},
  ): Promise<void> => {
    if (boxWorkers === null) return;
    await finishEndedBoxRuns(
      boxWorkers,
      (runId) => boxRunEnded(options.offices, runId),
      options.logger,
      // A listed box the index lost gets its entry again from the office that knows its run.
      { ...finishOptions, runDirOf: (runId) => paths.runDirOfRun(runId) },
    );
  };
  // The test boxes of stories under the maintainer's test (DIPO-309): made like every box, reached
  // through a forwarder on the Mac's loopback.
  const testBoxes =
    boxed === null
      ? null
      : new TestBoxes({
          workers: boxed.workers,
          boxes: boxed.boxes,
          forward: options.forwarders.forward,
          reach: options.forwarders.reach,
          clock,
          warn: (message, fields) => options.logger.warn(message, fields),
          info: (message, fields) => options.logger.info(message, fields),
        });
  // What else runs on the box tick: the sweep of the tests nobody records (DIPO-309).
  const hooks: (() => Promise<void>)[] = [];
  const afterBoxPass = async (): Promise<void> => {
    for (const hook of hooks) await hook().catch(() => undefined);
  };
  // A drop or a merge ends a claim with no worker exit, so a minute tick also runs the pass: the
  // box of a released claim is deleted within about a minute (DIPO-278).
  let boxTick: ReturnType<typeof clock.setTimeout> | null = null;
  let ticking = boxWorkers !== null;
  const armBoxTick = (): void => {
    if (!ticking) return;
    boxTick = clock.setTimeout(() => {
      boxTick = null;
      void finishEndedBoxes().then(afterBoxPass).finally(armBoxTick);
    }, BOX_PASS_TICK_MS);
  };
  armBoxTick();
  return {
    finishEndedBoxes,
    stopBoxPasses: () => {
      ticking = false;
      if (boxTick !== null) clock.clearTimeout(boxTick);
      boxTick = null;
    },
    testBoxes,
    onBoxTick: (hook) => void hooks.push(hook),
  };
}

/**
 * Run temp directories (DIPO-102): removed once their run ended and its worker hosts exited, swept
 * after each exit and its decision, and at daemon start (`sweep("recovery")`).
 */
function tempDirsOf(
  options: RunsOptions,
  tmpRoot: string,
): { readonly tempDirs: RunTempDirs; readonly sweepTempDirs: () => void } {
  const tempDirs = new RunTempDirs({
    tmpRoot,
    database: options.database,
    probe: options.probe,
    ...(options.uid >= 0 ? { uid: options.uid } : {}),
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  const sweepTempDirs = (): void => {
    void tempDirs.sweep("ended").then(
      (removed) => {
        if (removed.length > 0) {
          options.logger.info("removed ended runs' temp directories", { removed });
        }
      },
      (error: unknown) =>
        options.logger.warn("sweeping run temp directories failed", {
          reason: error instanceof Error ? error.message : String(error),
        }),
    );
  };
  return { tempDirs, sweepTempDirs };
}

/** The worker port: the Claude CLI's, with the box workers, wrapped when a test asks (DIPO-316). */
function workerOf(options: RunsOptions, boxWorkers: BoxWorkers | null): WorkerPort {
  const claude = claudeWorkerPort({
    spawn: options.spawn,
    clock: options.clock,
    claudePath: options.tools.claude,
    home: options.home,
    env: options.env,
    holds: options.holds,
    ...(boxWorkers === null ? {} : { boxes: boxWorkers }),
  });
  return options.workerPort === undefined ? claude : options.workerPort(claude);
}

/**
 * Conflicts with the base before In Review and the conflict hand-off of box runs (DIPO-149): the
 * sync runs in the run's held turn through the box collisions, a partner.
 */
function storyConflictsOf(
  options: RunsOptions,
  boxed: BoxedRuns | null,
  paths: RunPaths,
  collisions: Partner<BoxCollisions | null>,
): StoryConflicts | null {
  if (boxed === null) return null;
  return new StoryConflicts({
    stories: options.storyStore,
    clock: options.clock,
    ids: options.ids,
    offices: options.offices,
    git: (office) => options.engineGit.forOffice(office),
    sync: async (runId, mode) => {
      const run = paths.partRun(runId);
      const service = collisions.get();
      if (run === null || service === null) return { kind: "none" };
      return service.syncInTurn(run, mode);
    },
    onChanged: options.onChanged,
    warn: (message, fields) => options.logger.warn(message, fields),
  });
}

/** The office's verify in a box run's box (DIPO-346). */
function boxVerifyOf(
  options: RunsOptions,
  boxed: BoxedRuns,
): NonNullable<ConstructorParameters<typeof VerifyCommit>[0]["verify"]> {
  return async (office, run) => {
    const config = options.offices.config(office.officeId);
    const profile = currentProfile(office)?.profile ?? null;
    if (config === undefined || profile === null || run.story === null) {
      return {
        kind: "failed",
        reason: "dipo could not read the office's run profile to verify in the box",
      };
    }
    const verify = boxVerifyInput({ profile, config });
    if (verify === null) return { kind: "none" };
    if ("refused" in verify) return { kind: "failed", reason: verify.refused };
    return boxed.workers.verify({ runId: run.runId, ...verify });
  };
}

/**
 * In Review at a box run's done (DIPO-49, DIPO-273): its last part is taken at done, the office's
 * verify runs in its box (DIPO-346), and its end is claimed while its parts are held; CI on the
 * story PR is the final gate. No backstop or scope check.
 */
function finisherOf(
  options: RunsOptions,
  boxed: BoxedRuns | null,
  isBoxRun: (office: OfficeId, run: StoredRun) => boolean,
  storyConflicts: StoryConflicts | null,
): VerifyCommit {
  return new VerifyCommit({
    clock: options.clock,
    story: storyGitOf(options),
    profile: (office) => currentProfile(office)?.profile ?? null,
    ...(options.storyPr === undefined ? {} : { storyPr: options.storyPr }),
    // The report gate reads the story's test plan on the office base (DIPO-186).
    storyFacts: baseStoryFacts(options.base),
    ...(boxed === null
      ? {}
      : {
          parts: {
            isBoxRun,
            finishLast: (runId, message, finish) => boxed.parts.finishLast(runId, message, finish),
          },
          verify: boxVerifyOf(options, boxed),
          ...(storyConflicts === null ? {} : { conflicts: storyConflicts }),
        }),
    warn: (message, fields) => options.logger.warn(message, fields),
  });
}

function storyGitOf(options: RunsOptions): ReturnType<typeof gitStoryOps> {
  return gitStoryOps({
    git: (office) => options.engineGit.forOffice(office),
    stories: options.storyStore,
  });
}

/** The park and lift writers on a story branch, after auto-merge is off (0002). */
function branchWriters(options: RunsOptions): {
  readonly park: ParkWriter;
  readonly unpark: UnparkWriter;
} {
  const git = (office: OfficeId) => options.engineGit.forOffice(office);
  const park = gitParkWriter({ git, stories: options.storyStore });
  const unpark = gitUnparkWriter({ git, stories: options.storyStore });
  const off = options.autoMergeGuard;
  if (off === undefined) return { park, unpark };
  return { park: guardedParkWriter(park, off), unpark: guardedUnparkWriter(unpark, off) };
}

/** What the run ports are built from, besides the options. */
interface RunPortParts {
  readonly tmpRoot: string;
  readonly paths: RunPaths;
  readonly boxed: BoxedRuns | null;
  readonly worker: WorkerPort;
  readonly steering: RunSteering;
  readonly isBoxRun: (office: OfficeId, run: StoredRun) => boolean;
  readonly finisher: VerifyCommit;
  readonly sweeps: { readonly temp: () => void; readonly boxes: () => Promise<void> };
  readonly tempOwner: () => string | undefined;
  readonly collisions: Partner<BoxCollisions | null>;
}

/** The tier caps of the office in force for a run's tier. */
function tierOf(options: RunsOptions, office: OfficeId, run: StoredRun): TierCaps | undefined {
  return run.tier === null
    ? undefined
    : options.offices.config(office)?.tiers[run.tier as "S" | "M" | "L"];
}

function capsFor(options: RunsOptions): (office: OfficeId, run: StoredRun) => Caps | null {
  return (office, run) => {
    const tier = tierOf(options, office, run);
    const handle = options.offices.get(office);
    return tier === undefined || handle === undefined ? null : runCaps(handle, run, capsOf(tier));
  };
}

/** The merges dipo made on a box run's branch outside the box reach its box (DIPO-324). */
function boxSyncOf(options: RunsOptions, parts: RunPortParts): NonNullable<RunPorts["boxSync"]> {
  return async (office, run) => {
    const handle = options.offices.get(office);
    const pending = handle === undefined ? null : pendingBoxCopy(handle, run.runId);
    if (handle === undefined || pending === null) return;
    const part = parts.paths.partRun(run.runId);
    const boxWorkers = parts.boxed?.workers ?? null;
    const collisions = parts.collisions.get();
    if (part === null || part.runDir === undefined || boxWorkers === null || collisions === null) {
      throw new Error(`run ${run.runId} has no box dipo can copy into here`);
    }
    await boxWorkers.awake({ runId: run.runId, runDir: part.runDir });
    await collisions.copyPending(part, pending.from);
    handle.immediate(() => markBoxCopied(handle, run.runId, pending.ids));
  };
}

/** The run ports that come straight from the options (DIPO-129). */
function baseRunPorts(options: RunsOptions, parts: RunPortParts): Omit<RunPorts, "ingest"> {
  const refreshStory = options.stories;
  return {
    stories: options.storyStore,
    clock: options.clock,
    ids: options.ids,
    offices: options.offices,
    worker: parts.worker,
    steering: parts.steering,
    hosts: options.hosts,
    git: (office) => options.engineGit.forOffice(office),
    // A launch's dependencies and a run's next session read the stories on the base (DIPO-51).
    base: options.base,
    runtimeDir: options.runtimeDir,
    tmpRoot: parts.tmpRoot,
    // The daemon-start sweep removes a run it does not know only when this daemon made it.
    tempOwner: parts.tempOwner,
    ...(options.holdResumer === undefined ? {} : { holdResumer: options.holdResumer }),
    ...(options.mergeReentry === undefined ? {} : { mergeReentry: options.mergeReentry }),
    onChanged: options.onChanged,
    warn: (message, fields) => options.logger.warn(message, fields),
    ...(refreshStory === undefined
      ? {}
      : {
          refreshStory: (office: OfficeId, key: StoryKey) =>
            refreshStory.refreshStory(office, key, { quiet: true }),
        }),
    release: (office, claim, reason) => options.claims.releaseUnstarted(office, claim, reason),
    // The permission wait (DIPO-59) asks the maintainer when present, and holds while no work is scheduled.
    ...(options.presence === undefined ? {} : { presence: options.presence }),
    ...(options.scheduling === undefined ? {} : { scheduling: options.scheduling }),
  };
}

/** The run ports of the boxes, the story PR and the conflicts (DIPO-271, DIPO-324, 0002). */
function boxRunPorts(options: RunsOptions, parts: RunPortParts): Partial<RunPorts> {
  const boxWorkers = parts.boxed?.workers ?? null;
  const storyPr = options.storyPr;
  return {
    // A resumed conflict park merges in its live run's box (DIPO-324), and a story resumed to wait
    // In Review again gets a new story PR when its PR was closed (0002).
    conflictResume: {
      merge: conflictMergeOf({
        run: (runId) => parts.paths.partRun(runId),
        collisions: () => parts.collisions.get(),
        warn: (message, fields) => options.logger.warn(message, fields),
      }),
      stories: options.storyStore,
    },
    ...(storyPr?.replace === undefined
      ? {}
      : {
          prReplacement: () => ({
            replace: (office: OfficeId, run: StoredRun) =>
              storyPr.replace?.(office, run.runId) ?? Promise.resolve(),
          }),
        }),
    // Each exit decision may end the run after its worker exited: its temp directory goes then,
    // and a box run's box is checked and deleted (DIPO-271).
    afterExit: () => {
      parts.sweeps.temp();
      void parts.sweeps.boxes();
    },
    ...(boxWorkers === null ? {} : { boxes: boxWorkers }),
    // What Safe-Chain refused in a developer session is kept before its exit is decided (DIPO-376).
    ...(boxWorkers === null
      ? {}
      : { beforeExit: (runId: string) => boxWorkers.sessionEnded(runId) }),
    // Each review session runs in a read-only box of its own (0002).
    ...(boxWorkers === null ? {} : { reviewBoxes: boxWorkers }),
    // The merges dipo made on a box run's branch outside the box reach its box before the worker's
    // next session (DIPO-324): the box is started, the files copied in as a catch-up's are.
    boxSync: boxSyncOf(options, parts),
    // A fix round waits for the CI of the pushed head and carries its red items (DIPO-148); a box
    // run's developer gets a new session in its box (0021 section 6).
    ...(storyPr?.ciState === undefined
      ? {}
      : { ci: (office: OfficeId, runId: RunId) => storyPr.ciState?.(office, runId) ?? null }),
    boxRun: parts.isBoxRun,
  };
}

/** The run ports of ingestion, run control, worker outcomes and the starts paused. */
function controlRunPorts(
  options: RunsOptions,
  parts: RunPortParts,
): Pick<RunPorts, "ingest" | "control" | "outcomes" | "startsPaused"> {
  const writers = branchWriters(options);
  return {
    ingest: {
      // The watchdog (DIPO-52) writes `quiet` and `no-output` by the office's `timeouts`, and every
      // entry ingestion or the watchdog appends reaches subscribers at once.
      watchdog: new Watchdog({
        clock: options.clock,
        timeouts: (office) => options.offices.config(office)?.timeouts,
        onAppended: options.onChanged,
      }),
      onEnded: () => {
        // A run that ended before its worker exited loses its temp directory now (DIPO-102).
        parts.sweeps.temp();
        void parts.sweeps.boxes();
      },
    },
    // The park written on the story branch (DIPO-50), after auto-merge is off (0002).
    control: { finisher: parts.finisher, writer: writers.park, implemented: options.implemented },
    outcomes: {
      // No new host while an earlier host of the run still runs (DIPO-57, 0006 decision 8).
      probe: options.probe,
      holds: options.holds,
      holdsWork: storyHoldsWork(storyGitOf(options)),
      // Lifting a park on the story branch before its run resumes (DIPO-75), and a fix round's
      // In Progress commit, after auto-merge is off (0002).
      unpark: writers.unpark,
      caps: capsFor(options),
    },
    // The office's starts paused (0020): a plan limit pauses every loaded office, and a failed
    // adapter check pauses through the adapter's hold.
    startsPaused: {
      loaded: () => options.offices.loadedOffices(),
      holds: options.holds,
      adapter: CLAUDE_CLI_ADAPTER_ID,
    },
  };
}

/** Re-attach after a restart (0005): every active run's newest worker host is re-attached or parked. */
function reattachRunPorts(options: RunsOptions, parts: RunPortParts): Partial<RunPorts> {
  const { worker, paths } = parts;
  return {
    reattach: {
      probe: options.probe,
      // One verified SIGTERM to a host that does not answer after the restart (0005).
      signal: signalProcess,
      adapter: (office, run) => {
        const runPaths = paths.runPaths(office, run);
        const config = options.offices.config(office);
        return runPaths === null || config === undefined
          ? null
          : (worker.adapter(runPaths, config) as IngestAdapter);
      },
      initialState: ({ office, run, agent, resume, previous }) => {
        const runPaths = paths.runPaths(office, run);
        const inForce = tierOf(options, office, run);
        const handle = options.offices.get(office);
        if (runPaths === null || inForce === undefined || handle === undefined) return {};
        return startedSessionState(worker, {
          handle,
          run,
          agent,
          inForce,
          paths: runPaths,
          resume,
          ...(previous === undefined ? {} : { previous }),
        });
      },
      caps: capsFor(options),
    },
  };
}

/** Every run port (DIPO-129) the engine's run services are composed from. */
function runPortsOf(options: RunsOptions, parts: RunPortParts): RunPorts {
  return {
    ...baseRunPorts(options, parts),
    ...boxRunPorts(options, parts),
    ...controlRunPorts(options, parts),
    ...reattachRunPorts(options, parts),
  };
}

/** The composed run services the engine needs, each present; throws when one is not wired. */
function requireComposed(composed: ComposedRuns): ComposedRuns & {
  readonly control: RunControl;
  readonly outcomes: RunOutcomes;
  readonly resumption: Resumption;
  readonly reattacher: RunReattacher;
  readonly startsPaused: StartsPaused;
  readonly places: Places;
} {
  const { control, outcomes, resumption, reattacher, startsPaused, places } = composed;
  if (
    control === null ||
    outcomes === null ||
    resumption === null ||
    reattacher === null ||
    startsPaused === null ||
    places === null
  ) {
    throw new Error("the engine's run services are not all wired");
  }
  return { ...composed, control, outcomes, resumption, reattacher, startsPaused, places };
}

/**
 * The one connect step of the engine's run services (DIPO-318): each partner a service calls but
 * was built before is connected here, once every service exists.
 */
function connectRunsPartners(
  partners: RunsPartners,
  services: {
    readonly control: RunControl;
    readonly collisions: BoxCollisions | null;
    readonly workers: BoxWorkers | null;
  },
): void {
  // Box parts <-> run control: a part is taken only while its run is live, and a part that keeps
  // failing parks the run; run control is composed from ports that include the box workers.
  partners.control.connect(services.control);
  // Box workers, story conflicts and the box sync <-> box collisions: the collisions compare the
  // parts the box workers deliver, park and tell through run control, and are built last.
  partners.collisions.connect(services.collisions);
  // Box parts <-> box workers: the parts read each box's door, and the box workers deliver each
  // part the door takes through the parts. No box workers without a box backend: nothing reads
  // the door then.
  if (services.workers !== null) partners.workers.connect(services.workers);
}

/** The run services of the engine's offices, from claim to merge. */
export function buildRuns(options: RunsOptions): EngineRuns {
  const partners: RunsPartners = {
    control: new Partner("run control"),
    collisions: new Partner("the box collisions"),
    workers: new Partner("the box workers"),
  };
  const tmpRoot = realDir(options.tmpRoot);
  const paths = runPathsOf(options, tmpRoot);
  const boxed = engineBoxWorkers(
    options,
    tmpRoot,
    {
      run: (runId) => paths.partRun(runId),
      live: (runId) => partners.control.get().live(runId),
      park: (runId, park) => partners.control.get().parkRun(runId, park),
      // A part dipo keeps failing to take out of the box is told, never parked (DIPO-290).
      notice: (run, notice) => runNotice(options)(run.office, run.runId, notice),
      // No part is taken while the box lacks a merge dipo made outside it (DIPO-324).
      behind: boxBehind(options.offices),
    },
    partners,
  );
  // The token check's export folders and the part stages a stopped daemon left go first.
  void sweepBoxTokenChecks(tmpRoot, options.logger).catch(() => {});
  void sweepBoxPartStages(partStageRoot(options.stateDir), boxed?.parts ?? null, options.logger);
  const passes = boxPassesOf(options, boxed, paths);
  const { tempDirs, sweepTempDirs } = tempDirsOf(options, tmpRoot);
  // Whether a run's developer works in a box: its run directory says so (DIPO-271).
  const isBoxRun = (office: OfficeId, run: StoredRun): boolean => {
    const runPaths = boxed === null ? null : paths.runPaths(office, run);
    return runPaths !== null && boxed !== null && boxed.workers.isBoxRun(runPaths.runDir);
  };
  const storyConflicts = storyConflictsOf(options, boxed, paths, partners.collisions);
  const parts: RunPortParts = {
    tmpRoot,
    paths,
    boxed,
    worker: workerOf(options, boxed?.workers ?? null),
    // One steering for every run service: it keeps no state between sends.
    steering: hostSocketSteering({ clock: options.clock }),
    isBoxRun,
    finisher: finisherOf(options, boxed, isBoxRun, storyConflicts),
    sweeps: { temp: sweepTempDirs, boxes: () => passes.finishEndedBoxes() },
    tempOwner: () => tempDirs.owner(),
    collisions: partners.collisions,
  };
  const composed = requireComposed(composeRuns(runPortsOf(options, parts)));
  // Each head whose CI stops being pending may start its fix round (DIPO-148).
  const fixRounds = composed.fixRounds;
  options.storyPr?.onCiFinal?.((office, runId) => {
    void fixRounds?.consider(office, runId);
  });
  const collisions = boxCollisions(options, boxed, composed.control, paths.partRun, {
    service: storyConflicts,
    isBoxRun,
    unpark: branchWriters(options).unpark,
  });
  connectRunsPartners(partners, {
    control: composed.control,
    collisions,
    workers: boxed?.workers ?? null,
  });
  collisions?.start();
  return engineRunsOf(options, {
    composed,
    passes,
    tempDirs,
    boxed,
    isBoxRun,
    collisions,
    storyConflicts,
  });
}

/** What `buildRuns` hands back, from the services it built. */
function engineRunsOf(
  options: RunsOptions,
  built: {
    readonly composed: ReturnType<typeof requireComposed>;
    readonly passes: BoxPasses;
    readonly tempDirs: RunTempDirs;
    readonly boxed: BoxedRuns | null;
    readonly isBoxRun: (office: OfficeId, run: StoredRun) => boolean;
    readonly collisions: BoxCollisions | null;
    readonly storyConflicts: StoryConflicts | null;
  },
): EngineRuns {
  const { composed, passes } = built;
  const fixRounds = composed.fixRounds;
  return {
    sessions: composed.sessions,
    launcher: composed.launcher,
    ingest: composed.ingest,
    control: composed.control,
    outcomes: composed.outcomes,
    resumption: composed.resumption,
    permissions: composed.permissions,
    reattacher: composed.reattacher,
    startsPaused: composed.startsPaused,
    places: composed.places,
    tempDirs: built.tempDirs,
    boxes: built.boxed?.workers ?? null,
    isBoxRun: built.isBoxRun,
    collisions: built.collisions,
    finishEndedBoxes: passes.finishEndedBoxes,
    stopBoxPasses: passes.stopBoxPasses,
    testBoxes: passes.testBoxes,
    onBoxTick: passes.onBoxTick,
    sweepOldReviewFolders: () => sweepOldReviewFolders(realDir(options.tmpRoot)),
    recoverFixRounds: async () => {
      let queued = 0;
      for (const office of options.offices.loadedOffices()) {
        queued += (await fixRounds?.recover(office)) ?? 0;
      }
      return queued;
    },
    merge: mergePortsOf(options, fixRounds, built.storyConflicts),
  };
}

/**
 * The auto-merge's ports (0002): its conflicts and the maintainer's rejects go through the fix
 * rounds, and its conflict merges are recorded as DIPO-149's catch-ups are.
 */
function mergePortsOf(
  options: RunsOptions,
  fixRounds: ComposedRuns["fixRounds"],
  storyConflicts: StoryConflicts | null,
): RunMergePorts {
  return {
    conflict: async (office, runId, input) =>
      (await fixRounds?.conflict(office, runId, input)) ?? false,
    reject: async (office, runId, reject) =>
      (await fixRounds?.reject(office, runId, reject)) ?? false,
    testFail: async (office, runId, test) =>
      (await fixRounds?.testFail(office, runId, test)) ?? null,
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
      );
    },
    story: baseStoryFacts(options.base),
    itemMax: (office, run) => {
      const config = options.offices.config(office);
      if (config === undefined) return 3_000;
      const budgets = config.prompt.budgets.feedbackItem as Readonly<Record<string, number>>;
      return (
        (run.tier === null ? undefined : budgets[run.tier]) ?? config.prompt.budgets.feedbackItem.M
      );
    },
  };
}
