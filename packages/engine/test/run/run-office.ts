// A run office on real git with a bare `origin` and the pinned Backlog CLI (DIPO-74, DIPO-50): the
// Backlog fixture with TASK-1 made to pass the Ready gate, loaded as an office with the story
// index, the gate store, the claims, the planning lane and `work.run` with the run launcher. Setup
// is stubbed and the launch checks are DIPO-43's hold gate with scripted outcomes, so no `claude`
// process ever starts. The worker host is either a stub or DIPO-44's host in this process with a
// FakeProcess replaying a committed recording. The run services are built by `composeRuns` as the
// daemon builds them (DIPO-129): ingestion always has the permission wait (the maintainer absent)
// and the nudges; with `control`, run control (DIPO-50) is wired as the ingestion hooks, with the
// real park writer on the office git. Shared by the run CI tests.

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock, IdPrefix, OfficeId } from "@dipsaus-orchestrator/contract";
import {
  fakeSpawn,
  ManualClock,
  type TempRepoWithRemote,
  type Recording,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import { BacklogLane } from "../../src/backlog/lane";
import type { OfficeConfig } from "../../src/config";
import type { OfficeHandle } from "../../src/db/office";
import { GateStore } from "../../src/gate";
import { EngineGit } from "../../src/git";
import { WorkerHost } from "../../src/host/main";
import { EVENTS_FILE, hostSocketPath, HOSTS_DIR, LAUNCH_FILE } from "../../src/host/protocol";
import { officeStatusesReady } from "../../src/office/init";
import { ensurePrivateDir } from "../../src/platform/paths";
import {
  capsOf,
  cliRunBase,
  gitParkWriter,
  gitUnparkWriter,
  gitStoryOps,
  VerifyCommit,
  type HostStarter,
  OfficeIngest,
  type PlanLimits,
  type Resumption,
  RunControl,
  type RunSteering,
  composeRuns,
  RunOutcomes,
  type StoredRun,
  storyHoldsWork,
  WorkRun,
  RunTempDirs,
  runTempDir,
  readRunTempOwner,
} from "../../src/run";
import { readShortTempRun, shortTempDir } from "../../src/run/temp-dirs";
import { type LaunchedHost, recordWorkerHost, runDirectory } from "../../src/runs/worker-hosts";
import { standInPlan } from "./stand-in-plan";
import type { RunProfile } from "../../src/scan/detect";
import { StoryIndex } from "../../src/stories/feature";
import {
  claudeCliAdapter,
  claudeLaunchContext,
  claudeSessionFacts,
} from "../../src/workers/claude-cli/adapter";
import { encode } from "../../src/workers/claude-cli/encode";
import {
  type ClaudeParseState,
  initialState,
  nextSessionOptions,
} from "../../src/workers/claude-cli/interpret";
import { result as claudeResult } from "../../src/workers/claude-cli/result";
import { REPORT_JSON_SCHEMAS } from "../../src/workers/claude-cli/report-schema";
import { CLAUDE_LOCAL_SETTINGS } from "../../src/workers/claude-cli/settings-check";
import { AdapterHolds, gateLaunch, type LaunchCheckOutcome } from "../../src/workers/hold";
import type { RunLaunchPaths, WorkerPort } from "../../src/workers/port";
import type { Caps, HostOp, LaunchPlan, ParseState } from "../../src/workers/types";
import { hasLiveClaim, StoryClaims } from "../../src/worktree";
import type { SlotEntry } from "../../src/worktree/slots";
import type { SetupOutcome } from "../../src/worktree/setup";
import { backlog, CLI, publish } from "../gate/gated-office";
import { BACKLOG_FIXTURE, type OfficeSetup, officeSetup, resultOf, send } from "../office/helpers";
import { ROOMY } from "../worktree/helpers";
import { withBuiltinPlugins, withoutSkills } from "../workers/launch-fixtures";
import { loadRecording } from "../workers/replay";

export const CLAUDE = "/opt/claude/bin/claude";
export const BRANCH = "TASK-1/add-the-csv-export-command";

/** The body dipo gives a part commit, so the run's parts are counted (`box/parts.ts`). */
const PART_BODY = "Part 1 of TASK-1, delivered from its box by dipo.";

export type HostMode = "stub" | "replay";

function neverSpawn(): never {
  throw new Error("no claude process may start in this test");
}

const ctxOf = (paths: RunLaunchPaths, config: OfficeConfig) =>
  claudeLaunchContext(
    {
      claudePath: CLAUDE,
      home: "/home/maintainer",
      env: { PATH: "/usr/bin:/bin" },
      dipoCommand: ["/opt/dipo/bin/dipo"],
      pluginFiles: { read: () => undefined, dirs: () => [] },
    },
    paths,
    config,
  );

export interface Running {
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly holds: AdapterHolds;
  /** Every host start, with the run's event file size before it (DIPO-51). */
  readonly hosts: { runId: string; agentId: string; plan: LaunchPlan; sizeBefore: number }[];
  readonly ingest: OfficeIngest;
  readonly engineGit: EngineGit;
  /** Run control, when the office was set up with it. */
  readonly control: RunControl | null;
  /** The host ops run control sent, per call. */
  readonly sent: HostOp[][];
  /** Worker outcomes, when the office was set up with them (DIPO-51). */
  readonly outcomes: RunOutcomes | null;
  /** Park resume and `work.resume`, built with the outcomes (DIPO-138). */
  readonly resumption: Resumption | null;
  /** Each ingestion start with the host row's `processed_offset` at that moment. */
  readonly starts: { agent: string; processedOffset: number }[];
  /** The plan-limit schedule, when the office was set up with it (DIPO-61). */
  readonly planLimits: PlanLimits | null;
  /** The run temp directories' root (`<root>/tmp`). */
  readonly tmpRoot: string;
  /**
   * The run temp directory sweeps, when the office was set up with them (DIPO-102): `settled`
   * waits for every sweep started so far; `atHostStart` says, per host start, whether the run's
   * temp directory existed then.
   */
  readonly tempDirs: {
    settled(): Promise<void>;
    readonly atHostStart: boolean[];
    /** Per host start, the owner file in the run temp directory then (null when none). */
    readonly ownerAtHostStart: (string | null)[];
    /** Per host start, the run the short temp root's run file named then (DIPO-118). */
    readonly shortRunAtHostStart: (string | null)[];
    /** The owner this office writes. */
    owner(): string | undefined;
  } | null;
}

export interface RunOfficeOptions {
  readonly host: HostMode;
  /** Runs on the fixture after TASK-1 passes the gate and before the office opens. */
  readonly prepare?: (repo: TempRepoWithRemote) => Promise<void>;
  /**
   * Wires the run temp directory sweeps (DIPO-102) as the daemon does: after each worker exit is
   * ingested and after each exit decision of worker outcomes (which `outcomes` must ask for).
   */
  readonly tempDirs?: boolean;
  readonly checks: LaunchCheckOutcome;
  /** The recording a replay host plays; `success-single` by default. */
  readonly recording?: string;
  /** The recordings of the first, second, ... host start, before `recording` (DIPO-51). */
  readonly recordings?: readonly (string | Recording)[];
  /**
   * Wires worker outcomes and the run's next session (DIPO-51) into run control (which `control`
   * must also ask for): the real resumer on the office git and the base, its hosts the same
   * replay hosts.
   */
  readonly outcomes?: boolean;
  /**
   * Wires the plan-limit schedule (DIPO-61) into worker outcomes (which `outcomes` must also ask
   * for), with the tier caps a held run is resumed with.
   */
  readonly planLimits?: boolean;
  /** The live port slot entries `work.run` and `work.preview` check (DIPO-197). */
  readonly liveSlots?: () => readonly SlotEntry[];
  /**
   * Lets worker outcomes resume a parked run (DIPO-75): the real unpark writer on the office git
   * and the tier caps.
   */
  readonly resumeParks?: boolean;
  /** Wires run control; `caps` replaces the tier's caps it tracks the run with. */
  readonly control?: { readonly caps?: Partial<Caps> };
  /**
   * Wires In Review at done (DIPO-49, DIPO-273) into run control, on the office git and the
   * Backlog CLI, with the run's worktree standing in for its box: `beforeWorker` runs in the
   * worktree when the host starts, like the worker's own edits in its box, and the last part at
   * done commits them on the story branch. `profile` is the run profile.
   */
  readonly finisher?: {
    readonly beforeWorker?: (worktree: string) => Promise<void> | void;
    readonly profile: RunProfile;
  };
}

/** The fixture on a bare `origin` with TASK-1 made to pass the Ready gate. */
export async function withRunOffice(
  options: RunOfficeOptions,
  fn: (r: Running) => Promise<void>,
): Promise<void> {
  await withBareRemote(
    async (repo) => {
      mkdirSync(join(repo.dir, "backlog", "archive", "tasks"), { recursive: true });
      await repo.commitAll("fixture");
      await repo.git("push", "--quiet", "-u", "origin", "main");
      await repo.git("remote", "set-head", "origin", "main");
      await backlog(repo, ["milestone", "add", "M0 Walking skeleton"]);
      await backlog(repo, [
        "task",
        "edit",
        "TASK-1",
        "--type",
        "feature",
        "-m",
        "m-0",
        "--ref",
        "packages/export/",
      ]);
      await publish(repo, "make TASK-1 pass the gate");
      await options.prepare?.(repo);

      let setup: OfficeSetup | undefined;
      const loaded = (): OfficeSetup => {
        if (setup === undefined) throw new Error("the office setup is not built yet");
        return setup;
      };
      const offices = {
        get: (office: OfficeId) => setup?.manager.get(office),
        config: (office: OfficeId) => setup?.manager.config(office),
      };
      const engineGit = new EngineGit({ spawn: CLI(repo).spawn, env: repo.env });
      const index = new StoryIndex({ git: engineGit, cli: CLI(repo), offices });
      const gates = new GateStore({
        git: engineGit,
        cli: CLI(repo),
        offices,
        index,
        get clock() {
          return loaded().clock;
        },
        get ids() {
          return loaded().ids;
        },
      });
      const claims = new StoryClaims({
        cli: CLI(repo),
        git: (office) => engineGit.forOffice(office),
        disk: ROOMY,
      });
      const lane = new BacklogLane({
        cli: CLI(repo),
        git: (office) => engineGit.forOffice(office),
        liveClaim: hasLiveClaim,
      });
      const base = cliRunBase({ git: (office) => engineGit.forOffice(office), cli: CLI(repo) });
      const holds = new AdapterHolds({ clock: new ManualClock(), notify: () => undefined });
      const clock = new ManualClock();
      const worker: WorkerPort = {
        id: "claude-cli",
        reportSchema: REPORT_JSON_SCHEMAS,
        localSettings: CLAUDE_LOCAL_SETTINGS,
        adapter: (paths, config) => ({
          ...claudeCliAdapter(ctxOf(paths, config), { spawn: neverSpawn, clock }),
          plan: (spec) => standInPlan(spec, paths, CLAUDE),
        }),
        prepare: async (spec, paths) => {
          // The Claude CLI plans no developer on the Mac (DIPO-240): a stand-in plan.
          const plan = standInPlan(spec, paths, CLAUDE);
          const gate = await gateLaunch("claude-cli", holds, async () => options.checks);
          return gate.ok ? { ok: true, plan } : gate;
        },
        initialState: (spec, previous) =>
          initialState(
            previous === undefined
              ? { plannedModel: spec.model }
              : nextSessionOptions(
                  previous as unknown as ClaudeParseState,
                  spec.session.resume,
                  spec.model,
                ),
          ) as unknown as ParseState,
        encode,
        result: (state, exit) => claudeResult(state as unknown as ClaudeParseState, exit),
        sessionFacts: (state) => claudeSessionFacts(state as unknown as ClaudeParseState),
      };
      const runtimeDir = join(repo.root, "rt");
      const tmpRoot = join(repo.root, "tmp");
      // The run temp directory sweeps (DIPO-102), as the daemon wires them.
      const atHostStart: boolean[] = [];
      const ownerAtHostStart: (string | null)[] = [];
      const shortRunAtHostStart: (string | null)[] = [];
      const sweeps: Promise<unknown>[] = [];
      const tempDirs =
        options.tempDirs === true
          ? new RunTempDirs({ tmpRoot, database: () => loaded().state, probe: async () => null })
          : null;
      const sweep = (): void => {
        if (tempDirs !== null) sweeps.push(tempDirs.sweep("ended"));
      };
      const hosts: Running["hosts"] = [];
      // Each run's worktree, which stands in for its box (DIPO-240).
      const worktrees = new Map<string, string>();
      const hostStarter: HostStarter = {
        start: async (office, run) => {
          const runDir = runDirectory(run.officeDir, run.runId);
          const recording =
            options.recordings?.[hosts.length] ?? options.recording ?? "success-single";
          const eventFile = join(runDir, EVENTS_FILE);
          atHostStart.push(existsSync(runTempDir(tmpRoot, run.runId)));
          ownerAtHostStart.push(readRunTempOwner(runTempDir(tmpRoot, run.runId)));
          shortRunAtHostStart.push(readShortTempRun(shortTempDir(tmpRoot, run.runId)));
          hosts.push({
            runId: run.runId,
            agentId: run.agentId,
            plan: run.plan,
            sizeBefore: existsSync(eventFile) ? statSync(eventFile).size : 0,
          });
          worktrees.set(run.runId, run.plan.cwd);
          await options.finisher?.beforeWorker?.(run.plan.cwd);
          const socketPath = hostSocketPath(runtimeDir, run.runId);
          const host: LaunchedHost = {
            pid: 4242,
            startTimeMs: 0,
            runId: run.runId,
            agentId: run.agentId,
            socketPath,
            protocolVersion: 1,
            runDir,
            eventFile: join(runDir, EVENTS_FILE),
          };
          if (options.host === "replay") {
            // The DIPO-44 host in this process, its worker a FakeProcess replaying the recording.
            ensurePrivateDir(runDir);
            ensurePrivateDir(join(runtimeDir, HOSTS_DIR));
            writeFileSync(
              join(runDir, LAUNCH_FILE),
              JSON.stringify({
                version: 1,
                run: run.runId,
                agent: run.agentId,
                socket: socketPath,
                plan: run.plan,
              }),
              { mode: 0o600 },
            );
            const replayClock = new ManualClock();
            const started = WorkerHost.start({
              runId: run.runId,
              runDir,
              clock: replayClock,
              // The plugin check (DIPO-108) reads plugin names, which recordings redact; the skills
              // check (DIPO-130) refuses the bundled skills that recordings made before the plan
              // passed --disable-slash-commands list.
              spawn: fakeSpawn(
                withBuiltinPlugins(
                  withoutSkills(
                    typeof recording === "string" ? loadRecording(recording) : recording,
                  ),
                ),
                replayClock,
              ).spawn,
              killGroup: () => undefined,
              pid: 4242,
            });
            await started.done;
          }
          recordWorkerHost(office, host, loaded().clock, {
            ...(run.processedOffset === undefined ? {} : { processedOffset: run.processedOffset }),
            ...(run.record === undefined ? {} : { record: run.record }),
          });
          return host;
        },
      };
      const sent: HostOp[][] = [];
      // The replayed worker has exited by the time ingestion starts, so the steering records the
      // ops and reports the host gone, as a real one that exited would.
      const steering: RunSteering = {
        send: async (_office, _run, ops) => {
          sent.push([...ops]);
          return { ok: false, reason: "the worker host has exited" };
        },
      };
      const finisherOptions = options.finisher;
      const finisher =
        finisherOptions === undefined
          ? undefined
          : new VerifyCommit({
              get clock() {
                return loaded().clock;
              },
              story: gitStoryOps({ git: (office) => engineGit.forOffice(office), cli: CLI(repo) }),
              profile: () => finisherOptions.profile,
              // Every run is a box run (DIPO-240); here the box is the run's worktree: its last part
              // is what the worker wrote there, committed on the story branch as dipo commits a part.
              parts: {
                isBoxRun: () => true,
                finishLast: async (runId, message, finish) => {
                  const worktree = worktrees.get(runId);
                  if (worktree === undefined) throw new Error(`no worktree for ${runId}`);
                  await repo.run(["git", "add", "--all"], worktree);
                  const staged = await repo.run(["git", "diff", "--cached", "--quiet"], worktree);
                  if (staged.exitCode !== 0) {
                    await repo.run(
                      ["git", "commit", "--quiet", "-m", message, "-m", PART_BODY],
                      worktree,
                    );
                  }
                  const tipOf = async () =>
                    (await repo.run(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
                  const tip = await tipOf();
                  const result = await finish({ tip, branchTip: tipOf });
                  return { outcome: { kind: "empty" }, finished: { result } };
                },
              },
            });
      // The clock and ids of the office setup, which is built after this wiring.
      const officeClock: Clock = {
        now: () => loaded().clock.now(),
        setTimeout: (callback, delayMs) => loaded().clock.setTimeout(callback, delayMs),
        clearTimeout: (handle) => loaded().clock.clearTimeout(handle),
      };
      const capsOverride = options.control?.caps ?? {};
      // Worker outcomes and the run's next session (DIPO-51), on the same replay hosts.
      const starts: Running["starts"] = [];
      const composed = composeRuns({
        clock: officeClock,
        ids: { next: (prefix: IdPrefix) => loaded().ids.next(prefix) },
        offices,
        worker,
        steering,
        hosts: hostStarter,
        git: (office) => engineGit.forOffice(office),
        base,
        runtimeDir,
        tmpRoot,
        ...(tempDirs === null ? {} : { tempOwner: () => tempDirs.owner() }),
        release: (office, claim, reason) => claims.releaseUnstarted(office, claim, reason),
        ...(tempDirs === null ? {} : { afterExit: sweep }),
        ingest: {
          pricing: () => null,
          ...(tempDirs === null ? {} : { onEnded: () => sweep() }),
        },
        ...(options.control === undefined
          ? {}
          : {
              control: {
                writer: gitParkWriter({
                  git: (office) => engineGit.forOffice(office),
                  cli: CLI(repo),
                }),
                ...(finisher === undefined ? {} : { finisher }),
              },
            }),
        tracker: (control) => ({
          track: (office, run) => {
            const caps = { ...run.caps, ...capsOverride };
            // Run control counts the run's start snapshot (DIPO-143), so the override goes there.
            if (Object.keys(capsOverride).length > 0) {
              loaded()
                .manager.get(office)
                ?.run(
                  `update runs set budget_limit = $budget, max_turns = $turns,
                     max_minutes = $minutes where office_id = $office_id and run_id = $run`,
                  {
                    budget: caps.budgetTokens,
                    turns: caps.maxTurns,
                    minutes: caps.maxMinutes,
                    run: run.runId,
                  },
                );
            }
            control.track(office, { ...run, caps });
          },
        }),
        resumeIngest: (officeIngest) => ({
          start: (office, host, target) => {
            const row = office.get<{ processed_offset: number }>(
              `select processed_offset from worker_hosts
                where office_id = $office_id and run_id = $run and agent_id = $agent`,
              { run: host.runId, agent: host.agentId },
            );
            starts.push({ agent: host.agentId, processedOffset: row?.processed_offset ?? -1 });
            officeIngest.start(office, host, target);
          },
        }),
        ...(options.outcomes === true
          ? {
              outcomes: {
                holds,
                holdsWork: storyHoldsWork(
                  gitStoryOps({ git: (office) => engineGit.forOffice(office), cli: CLI(repo) }),
                ),
                caps: (office: OfficeId, run: StoredRun) => {
                  if (
                    (options.planLimits !== true && options.resumeParks !== true) ||
                    run.tier === null
                  ) {
                    return null;
                  }
                  const tier = loaded().manager.config(office)?.tiers[run.tier as "S" | "M" | "L"];
                  return tier === undefined ? null : capsOf(tier);
                },
                ...(options.resumeParks === true
                  ? {
                      unpark: gitUnparkWriter({
                        git: (office) => engineGit.forOffice(office),
                        cli: CLI(repo),
                      }),
                    }
                  : {}),
              },
            }
          : {}),
        ...(options.planLimits === true ? { planLimits: { holds } } : {}),
        // Setup is stubbed: no install step runs (DIPO-39's own tests cover the real one).
        setup: async (): Promise<SetupOutcome> =>
          ({
            ok: true,
            slot: 1,
            env: {},
            files: { log: [], skipped: [], envFiles: [], settings: null },
            log: ["setup: done"],
            release: () => undefined,
          }) as unknown as SetupOutcome,
      });
      const { ingest, permissions, control, outcomes, resumption, planLimits, launcher } = composed;
      const workRun = new WorkRun({
        offices: {
          get: (office) => loaded().manager.get(office),
          config: (office) => loaded().manager.config(office),
          configHash: (office) => loaded().manager.configHash(office),
          configBlocksRuns: (office) => loaded().manager.configBlocksRuns(office),
        },
        base,
        stories: index,
        profiles: { ensureFreshProfile: async () => undefined, verifyResolved: () => null },
        statuses: async (office) => {
          const git = engineGit.forOffice(office);
          if (git === undefined) throw new Error("no git");
          return officeStatusesReady(git);
        },
        adapterHeld: (adapter) => holds.adapterHeld(adapter),
        claims,
        gates,
        lane: (office) => lane.forOffice(office),
        launcher,
        ...(options.liveSlots === undefined ? {} : { liveSlots: options.liveSlots }),
      });
      const s = await officeSetup(repo.root, {
        features: [
          engineGit.feature,
          claims.feature,
          lane.feature,
          index.feature,
          gates.feature,
          workRun.feature,
          ...(control === null ? [] : [control.feature]),
        ],
      });
      setup = s;
      try {
        const { office: officeId } = resultOf<{ office: OfficeId }>(
          await send(s, "office.open", { path: repo.dir }),
        );
        const access = await s.manager.load(officeId);
        if (!access.ok) throw new Error(`${access.error.code}: ${access.error.message}`);
        await fn({
          repo,
          s,
          officeId,
          office: access.office,
          holds,
          hosts,
          ingest,
          engineGit,
          control,
          sent,
          outcomes,
          resumption,
          starts,
          planLimits,
          tmpRoot,
          tempDirs:
            tempDirs === null
              ? null
              : {
                  settled: async () => {
                    while (sweeps.length > 0) await Promise.all(sweeps.splice(0));
                  },
                  atHostStart,
                  ownerAtHostStart,
                  shortRunAtHostStart,
                  owner: () => tempDirs.owner(),
                },
        });
      } finally {
        planLimits?.close();
        permissions.close();
        control?.close();
        ingest.close();
        index.stop();
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}
