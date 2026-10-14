// The worker start of claimed runs in the daemon (DIPO-74): the run launcher with the Claude CLI
// worker port, DIPO-39's setup, detached worker hosts and ingestion, all with the tools this
// daemon resolved on its PATH at start. `claude` and `backlog` are absolute paths, never looked up
// again; a missing `claude` refuses each launch with a notice instead of stopping the daemon.

import { realpathSync } from "node:fs";

import type {
  Clock,
  CommandName,
  OfficeId,
  Spawn,
  StoryKey,
  ToolPaths,
} from "@dipsaus-orchestrator/contract";
import {
  type AdapterHolds,
  type BacklogCli,
  claudeWorkerPort,
  currentProfile,
  gitParkWriter,
  hostSocketSteering,
  type EngineGit,
  type Logger,
  OfficeIngest,
  type OfficeManager,
  type RunBase,
  RunControl,
  RunLauncher,
  runSandboxedStep,
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
  systemSpawn,
  type currentPlatform,
  Watchdog,
} from "@dipsaus-orchestrator/engine";

/** The Backlog CLI at the absolute path the daemon resolved, else `backlog` on `PATH` (AC #8). */
export function backlogCliFor(tools: ToolPaths, spawn: Spawn = systemSpawn): BacklogCli {
  return tools.backlog === undefined ? { spawn } : { spawn, command: [tools.backlog] };
}

export interface DaemonRunsOptions {
  readonly tools: ToolPaths;
  readonly platform: ReturnType<typeof currentPlatform>;
  readonly clock: Clock;
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
  /** The story index, which reads a parked story again on its branch (DIPO-56). */
  readonly stories?: StoryIndex;
}

export interface DaemonRuns {
  readonly launcher: RunLauncher;
  readonly ingest: OfficeIngest;
  /** Caps, report parks and `work.stop` (DIPO-50). */
  readonly control: RunControl;
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
  });
  // The ingestion hooks call the control, and the control flushes ingestion's output first.
  let ingest: OfficeIngest | null = null;
  const control = new RunControl({
    clock,
    offices: options.offices,
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
  ingest = new OfficeIngest({
    clock,
    hooks: control.hooks,
    pricing: () => options.database()?.pricing ?? null,
    warn: (message, fields) => options.logger.warn(message, fields),
    watchdog,
    onAppended: options.onChanged,
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
    hosts: systemHostStarter({
      clock,
      runtimeDir: options.runtimeDir,
      dipoCommand: selfCommand(),
      env,
      probe: systemProcessProbe(platform),
    }),
    ingest,
    control,
    release: (office, claim, reason) => options.claims.releaseUnstarted(office, claim, reason),
    warn: (message, fields) => options.logger.warn(message, fields),
  });
  return { launcher, ingest, control };
}
