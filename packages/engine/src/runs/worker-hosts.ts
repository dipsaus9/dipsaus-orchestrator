// Starting a worker host and recording it (0006 decision 8, 0007 sections 2 and 4). The engine
// writes `launch.json` into the run directory, starts `dipo daemon worker-host <run-id>` detached
// with stdio appended to `host.log` and `BUN_OPTIONS` removed, reads the host's start time and
// records PID, start time, socket path and host protocol version in `worker_hosts`. Hosts are not
// daemon children (`ChildProcesses`): a drain leaves them running.
//
// Liveness is PID plus start time through the DIPO-23 identity check, where a zombie is dead;
// the socket is never asked (0006 decision 8).

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import {
  EVENTS_FILE,
  EXIT_FILE,
  HOST_LOG_FILE,
  HOST_PROTOCOL_VERSION,
  HostExitFileSchema,
  HOSTS_DIR,
  hostSocketPath,
  LAUNCH_FILE,
  RUN_ID_PATTERN,
  type HostExitFile,
  type HostLaunch,
} from "../host/protocol";
import { ensurePrivateDir, type Env } from "../platform/paths";
import {
  detachedEnv,
  isSameProcess,
  systemSpawnDetached,
  type ProcessIdentity,
  type ProcessProbe,
  type SpawnDetached,
} from "../platform/process";
import { systemdScopeCommand, underSystemdUnit } from "../platform/supervisor";
import type { LaunchPlan } from "../workers/types";

/** The host reads its run directory from this variable; its cwd is the run directory too. */
export const RUN_DIR_ENV = "DIPO_RUN_DIR";

/** `<git-common-dir>/dipo/runs/<run-id>` (0007 section 2). */
export function runDirectory(officeDir: string, runId: string): string {
  return join(officeDir, "runs", runId);
}

export interface LaunchWorkerHostOptions {
  readonly runId: string;
  readonly agentId: string;
  /** `<git-common-dir>/dipo`, the office's repository directory. */
  readonly officeDir: string;
  readonly runtimeDir: string;
  readonly plan: LaunchPlan;
  /** How to run `dipo` (`selfCommand()`): the binary, or Bun with the entry script. */
  readonly dipoCommand: readonly [string, ...string[]];
  /** The daemon's environment; `BUN_OPTIONS` is removed before the host gets it. */
  readonly env: Env;
  readonly probe: ProcessProbe;
  readonly spawnDetached?: SpawnDetached;
  /**
   * Start the host in its own transient systemd scope (0006 decision 8). Defaults to whether the
   * daemon runs inside the installed `dipo.service` unit.
   */
  readonly systemdScope?: boolean;
}

export interface LaunchedHost extends ProcessIdentity {
  readonly runId: string;
  readonly agentId: string;
  readonly socketPath: string;
  readonly protocolVersion: number;
  readonly runDir: string;
  readonly eventFile: string;
  /** The secret in `launch.json` that marks the engine's connections (DIPO-59); absent in old rows. */
  readonly engineToken?: string | null;
}

export class HostStartError extends Error {
  override readonly name = "HostStartError";
}

/** Writes `launch.json` and starts the host detached; resolves with its identity. */
export async function launchWorkerHost(options: LaunchWorkerHostOptions): Promise<LaunchedHost> {
  if (!RUN_ID_PATTERN.test(options.runId)) {
    throw new HostStartError(`not a run id: ${options.runId}`);
  }
  const runDir = runDirectory(options.officeDir, options.runId);
  ensurePrivateDir(runDir);
  ensurePrivateDir(join(options.runtimeDir, HOSTS_DIR));
  const socketPath = hostSocketPath(options.runtimeDir, options.runId);
  // The engine's secret for this host (DIPO-59): random, not an id, so not from the IdSource.
  const engineToken = randomBytes(32).toString("hex");
  const launch: HostLaunch = {
    version: 1,
    run: options.runId,
    agent: options.agentId,
    socket: socketPath,
    plan: options.plan,
    token: engineToken,
  };
  const launchPath = join(runDir, LAUNCH_FILE);
  writeFileSync(`${launchPath}.tmp`, JSON.stringify(launch), { mode: 0o600 });
  renameSync(`${launchPath}.tmp`, launchPath);

  const spawn = options.spawnDetached ?? systemSpawnDetached;
  // launch.json holds the task message: it never stays behind when the host did not start.
  let pid: number;
  let info: Awaited<ReturnType<ProcessProbe>>;
  const hostCmd: [string, ...string[]] = [
    ...options.dipoCommand,
    "daemon",
    "worker-host",
    options.runId,
  ];
  try {
    ({ pid } = spawn({
      // Under systemd the host gets its own scope, so stopping the daemon's unit leaves it running.
      cmd:
        (options.systemdScope ?? underSystemdUnit())
          ? systemdScopeCommand(options.runId, hostCmd)
          : hostCmd,
      cwd: runDir,
      env: { ...detachedEnv(options.env), [RUN_DIR_ENV]: runDir },
      outputFile: join(runDir, HOST_LOG_FILE),
    }));
    info = await options.probe(pid);
  } catch (error) {
    rmSync(launchPath, { force: true });
    throw error;
  }
  if (info === null || info.zombie) {
    rmSync(launchPath, { force: true });
    throw new HostStartError(`the worker host for ${options.runId} (pid ${pid}) exited at once`);
  }
  return {
    pid,
    startTimeMs: info.startTimeMs,
    runId: options.runId,
    agentId: options.agentId,
    socketPath,
    protocolVersion: HOST_PROTOCOL_VERSION,
    runDir,
    eventFile: join(runDir, EVENTS_FILE),
    engineToken,
  };
}

/** What is recorded together with a started host, in the same transaction (DIPO-57). */
export interface HostRecordExtras {
  /** Where ingestion of the host starts in the run's event file; 0 by default. */
  readonly processedOffset?: number;
  /** Writes that belong with the host row (the new agent), run inside the same transaction. */
  readonly record?: () => void;
}

/** Records a started host in `worker_hosts`, in its own write transaction. */
export function recordWorkerHost(
  office: OfficeHandle,
  host: LaunchedHost,
  clock: Clock,
  extras: HostRecordExtras = {},
): void {
  office.immediate(() => {
    office.run(
      `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
         protocol_version, run_dir, event_file, processed_offset, started_at, engine_token)
       values ($office_id, $run, $agent, $pid, $start, $socket, $protocol, $dir, $events,
         $offset, $now, $token)`,
      {
        run: host.runId,
        agent: host.agentId,
        pid: host.pid,
        start: host.startTimeMs,
        socket: host.socketPath,
        protocol: host.protocolVersion,
        dir: host.runDir,
        events: host.eventFile,
        offset: extras.processedOffset ?? 0,
        now: clock.now(),
        token: host.engineToken ?? null,
      },
    );
    extras.record?.();
  });
}

/** Starts the host for a run and records it (DIPO-74 calls this for a claimed run). */
export async function startWorkerHost(
  office: OfficeHandle,
  clock: Clock,
  options: LaunchWorkerHostOptions,
  extras: HostRecordExtras = {},
): Promise<LaunchedHost> {
  const host = await launchWorkerHost(options);
  recordWorkerHost(office, host, clock, extras);
  return host;
}

/** One `worker_hosts` row. */
export interface WorkerHostRow extends ProcessIdentity {
  readonly runId: string;
  readonly agentId: string;
  readonly socketPath: string;
  readonly protocolVersion: number;
  readonly runDir: string;
  readonly eventFile: string;
  readonly processedOffset: number;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  /** True when the host inferred `exitSignal` from the signal it sent last (DIPO-88). */
  readonly exitSignalInferred: boolean;
  readonly finalOffset: number | null;
  readonly endedAt: number | null;
  readonly mode: "steer" | "follow";
  readonly startedAt: number;
  /** The engine's secret for this host; null for a host started before DIPO-59. */
  readonly engineToken: string | null;
}

interface RawRow {
  run_id: string;
  agent_id: string;
  pid: number;
  start_time_ms: number;
  socket_path: string;
  protocol_version: number;
  run_dir: string;
  event_file: string;
  processed_offset: number;
  exit_code: number | null;
  exit_signal: string | null;
  exit_signal_inferred: number;
  final_offset: number | null;
  ended_at: number | null;
  mode: "steer" | "follow";
  started_at: number;
  engine_token: string | null;
}

/** The hosts of a run, oldest first. */
export function workerHostsOf(office: OfficeHandle, runId: string): WorkerHostRow[] {
  return office
    .all<RawRow>(
      "select * from worker_hosts where office_id = $office_id and run_id = $run order by started_at, rowid",
      { run: runId },
    )
    .map((row) => ({
      runId: row.run_id,
      agentId: row.agent_id,
      pid: row.pid,
      startTimeMs: row.start_time_ms,
      socketPath: row.socket_path,
      protocolVersion: row.protocol_version,
      runDir: row.run_dir,
      eventFile: row.event_file,
      processedOffset: row.processed_offset,
      exitCode: row.exit_code,
      exitSignal: row.exit_signal,
      exitSignalInferred: row.exit_signal_inferred === 1,
      finalOffset: row.final_offset,
      endedAt: row.ended_at,
      mode: row.mode,
      startedAt: row.started_at,
      engineToken: row.engine_token,
    }));
}

/** Records what `exit.json` says on the host's row. */
export function recordHostExit(office: OfficeHandle, agentId: string, exit: HostExitFile): void {
  office.immediate(() =>
    office.run(
      `update worker_hosts set exit_code = $code, exit_signal = $signal,
         exit_signal_inferred = $inferred, final_offset = $final,
         ended_at = $at where office_id = $office_id and run_id = $run and agent_id = $agent`,
      {
        code: exit.code,
        signal: exit.signal,
        inferred: exit.signalInferred === true && exit.signal !== null ? 1 : 0,
        final: exit.finalOffset,
        at: exit.at,
        run: exit.run,
        agent: agentId,
      },
    ),
  );
}

/** The run directory's `exit.json`, or null when it is missing or unreadable. */
export function readHostExit(runDir: string): HostExitFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(runDir, EXIT_FILE), "utf8"));
  } catch {
    return null;
  }
  const parsed = HostExitFileSchema.safeParse(raw);
  return parsed.success ? (parsed.data as HostExitFile) : null;
}

/**
 * The exit file of `host`, or null (DIPO-57). The hosts of a run share its run directory, so the
 * file may be an earlier host's; that one ends where this host's ingestion started. This host's
 * own file ends past its exit line, which is not processed while its agent has not ended, so a
 * file counts when it ends past the processed offset.
 */
export function exitFileOf(
  host: Pick<WorkerHostRow, "runId" | "runDir" | "processedOffset">,
): HostExitFile | null {
  const exit = readHostExit(host.runDir);
  if (exit === null || exit.run !== host.runId) return null;
  return exit.finalOffset > host.processedOffset ? exit : null;
}

/**
 * True when the recorded host process still runs: same PID and a start time within the DIPO-23
 * tolerance, not a zombie. The host socket is never consulted.
 */
export async function hostAlive(host: ProcessIdentity, probe: ProcessProbe): Promise<boolean> {
  return isSameProcess(host, await probe(host.pid));
}
