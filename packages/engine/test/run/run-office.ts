// A run office on real git with a bare `origin` and the pinned Backlog CLI (DIPO-74, DIPO-50): the
// Backlog fixture with TASK-1 made to pass the Ready gate, loaded as an office with the story
// index, the gate store, the claims, the planning lane and `work.run` with the run launcher. Setup
// is stubbed and the launch checks are DIPO-43's hold gate with scripted outcomes, so no `claude`
// process ever starts. The worker host is either a stub or DIPO-44's host in this process with a
// FakeProcess replaying a committed recording. With `control`, run control (DIPO-50) is wired as
// the ingestion hooks, with the real park writer on the office git. Shared by start.ci.test.ts and
// park.ci.test.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OfficeId } from "@dipsaus-orchestrator/contract";
import {
  fakeSpawn,
  ManualClock,
  type TempRepoWithRemote,
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
  cliRunBase,
  gitParkWriter,
  gitStoryOps,
  readBackstop,
  VerifyCommit,
  type HostStarter,
  OfficeIngest,
  RunControl,
  type RunSteering,
  RunLauncher,
  WorkRun,
} from "../../src/run";
import { type LaunchedHost, recordWorkerHost, runDirectory } from "../../src/runs/worker-hosts";
import type { StepResult } from "../../src/sandbox/step";
import type { RunProfile } from "../../src/scan/detect";
import { StoryIndex } from "../../src/stories/feature";
import { claudeCliAdapter, claudeLaunchContext } from "../../src/workers/claude-cli/adapter";
import { encode } from "../../src/workers/claude-cli/encode";
import { initialState } from "../../src/workers/claude-cli/interpret";
import { AdapterHolds, gateLaunch, type LaunchCheckOutcome } from "../../src/workers/hold";
import type { RunLaunchPaths, WorkerPort } from "../../src/workers/port";
import type { Caps, HostOp, LaunchPlan, ParseState } from "../../src/workers/types";
import { hasLiveClaim, StoryClaims } from "../../src/worktree";
import type { SetupOutcome } from "../../src/worktree/setup";
import { backlog, CLI, publish } from "../gate/gated-office";
import { BACKLOG_FIXTURE, type OfficeSetup, officeSetup, resultOf, send } from "../office/helpers";
import { ROOMY } from "../worktree/helpers";
import { loadRecording } from "../workers/replay";

export const CLAUDE = "/opt/claude/bin/claude";
export const BRANCH = "TASK-1/add-the-csv-export-command";

export type HostMode = "stub" | "replay";

function neverSpawn(): never {
  throw new Error("no claude process may start in this test");
}

const ctxOf = (paths: RunLaunchPaths, config: OfficeConfig) =>
  claudeLaunchContext(
    { claudePath: CLAUDE, home: "/home/maintainer", env: { PATH: "/usr/bin:/bin" } },
    paths,
    config,
  );

export interface Running {
  readonly repo: TempRepoWithRemote;
  readonly s: OfficeSetup;
  readonly officeId: OfficeId;
  readonly office: OfficeHandle;
  readonly holds: AdapterHolds;
  readonly hosts: { runId: string; plan: LaunchPlan }[];
  readonly ingest: OfficeIngest;
  readonly engineGit: EngineGit;
  /** Run control, when the office was set up with it. */
  readonly control: RunControl | null;
  /** The host ops run control sent, per call. */
  readonly sent: HostOp[][];
}

export interface RunOfficeOptions {
  readonly host: HostMode;
  readonly checks: LaunchCheckOutcome;
  /** The recording a replay host plays; `success-single` by default. */
  readonly recording?: string;
  /** Wires run control; `caps` replaces the tier's caps it tracks the run with. */
  readonly control?: { readonly caps?: Partial<Caps> };
  /**
   * Wires verify and commit (DIPO-49) into run control, on the office git and the Backlog CLI,
   * with a fake sandboxed step: each verify command exits with the next of `exitCodes` (0 when
   * none are left). `beforeWorker` runs in the worktree when the host starts, after the backstop
   * snapshot, like the worker's own edits. `profile` is the run profile, base and branch.
   */
  readonly finisher?: {
    readonly exitCodes?: number[];
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
        adapter: (paths, config) =>
          claudeCliAdapter(ctxOf(paths, config), { spawn: neverSpawn, clock }),
        prepare: async (spec, paths, config) => {
          const plan = claudeCliAdapter(ctxOf(paths, config), { spawn: neverSpawn, clock }).plan(
            spec,
          );
          const gate = await gateLaunch("claude-cli", holds, async () => options.checks);
          return gate.ok ? { ok: true, plan } : gate;
        },
        initialState: (spec) => initialState({ plannedModel: spec.model }) as unknown as ParseState,
        encode,
      };
      const runtimeDir = join(repo.root, "rt");
      const hosts: Running["hosts"] = [];
      const hostStarter: HostStarter = {
        start: async (office, run) => {
          hosts.push({ runId: run.runId, plan: run.plan });
          await options.finisher?.beforeWorker?.(run.plan.cwd);
          const runDir = runDirectory(run.officeDir, run.runId);
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
              spawn: fakeSpawn(loadRecording(options.recording ?? "success-single"), replayClock)
                .spawn,
              killGroup: () => undefined,
              pid: 4242,
            });
            await started.done;
          }
          recordWorkerHost(office, host, loaded().clock);
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
      let ingest: OfficeIngest | null = null;
      const finisherOptions = options.finisher;
      const exitCodes = [...(finisherOptions?.exitCodes ?? [])];
      const finisher =
        finisherOptions === undefined
          ? undefined
          : new VerifyCommit({
              get clock() {
                return loaded().clock;
              },
              story: gitStoryOps({ git: (office) => engineGit.forOffice(office), cli: CLI(repo) }),
              mainCheckout: () => repo.dir,
              runStep: async (request): Promise<StepResult> => {
                const code = exitCodes.shift() ?? 0;
                const text = code === 0 ? "1 pass\n" : "1 fail\n";
                request.onOutput?.(text);
                return {
                  outcome: "exited",
                  code,
                  signal: null,
                  timedOut: false,
                  stdout: { text, truncated: false },
                  stderr: { text: "", truncated: false },
                  warnings: [],
                };
              },
              config: (office) => loaded().manager.config(office),
              profile: () => finisherOptions.profile,
              scanWorktree: async () => finisherOptions.profile,
              host: { home: repo.root, uid: 501, env: { PATH: "/usr/bin:/bin" } },
            });
      const control =
        options.control === undefined
          ? null
          : new RunControl({
              ...(finisher === undefined ? {} : { finisher }),
              get clock() {
                return loaded().clock;
              },
              offices: { get: (office) => loaded().manager.get(office) },
              writer: gitParkWriter({
                git: (office) => engineGit.forOffice(office),
                cli: CLI(repo),
              }),
              steering,
              encode,
              flushOutput: (office, run) => ingest?.flushOutput(office, run),
            });
      ingest = new OfficeIngest({
        clock: new ManualClock(),
        pricing: () => null,
        ...(control === null ? {} : { hooks: control.hooks }),
      });
      const capsOverride = options.control?.caps ?? {};
      const launcher = new RunLauncher({
        worker,
        git: (office) => engineGit.forOffice(office),
        setup: async (): Promise<SetupOutcome> =>
          ({
            ok: true,
            slot: 1,
            env: {},
            files: { log: [], skipped: [], envFiles: [], settings: null },
            log: ["setup: done"],
            release: () => undefined,
          }) as unknown as SetupOutcome,
        dependencies: async () => [],
        runtimeDir,
        tmpRoot: join(repo.root, "tmp"),
        hosts: hostStarter,
        ingest,
        ...(control === null
          ? {}
          : {
              control: {
                track: (office, run) =>
                  control.track(office, { ...run, caps: { ...run.caps, ...capsOverride } }),
              },
            }),
        release: (office, claim, reason) => claims.releaseUnstarted(office, claim, reason),
        ...(finisher === undefined
          ? {}
          : {
              snapshot: (office: OfficeId, worktree: string) => {
                const git = engineGit.forOffice(office);
                if (git === undefined) throw new Error("no git");
                return readBackstop(git, worktree);
              },
            }),
      });
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
        });
      } finally {
        control?.close();
        ingest.close();
        index.stop();
        s.state.close();
      }
    },
    { fixture: BACKLOG_FIXTURE },
  );
}
