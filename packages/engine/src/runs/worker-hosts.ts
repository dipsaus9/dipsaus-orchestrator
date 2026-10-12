// Starting a worker host and recording it (0006 decision 8, 0007 sections 2 and 4). The engine
// writes `launch.json` into the run directory, starts `dipo daemon worker-host <run-id>` detached
// with stdio appended to `host.log` and `BUN_OPTIONS` removed, reads the host's start time and
// records PID, start time, socket path and host protocol version in `worker_hosts`. Hosts are not
// daemon children (`ChildProcesses`): a drain leaves them running.
//
// Liveness is PID plus start time through the DIPO-23 identity check, where a zombie is dead;
// the socket is never asked (0006 decision 8).

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import {
  EVENTS_FILE,
  HOST_LOG_FILE,
  HOST_PROTOCOL_VERSION,
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
}

export interface LaunchedHost extends ProcessIdentity {
  readonly runId: string;
  readonly agentId: string;
  readonly socketPath: string;
  readonly protocolVersion: number;
  readonly runDir: string;
  readonly eventFile: string;
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
  const launch: HostLaunch = {
    version: 1,
    run: options.runId,
    agent: options.agentId,
    socket: socketPath,
    plan: options.plan,
  };
  const launchPath = join(runDir, LAUNCH_FILE);
  writeFileSync(`${launchPath}.tmp`, JSON.stringify(launch), { mode: 0o600 });
  renameSync(`${launchPath}.tmp`, launchPath);

  const spawn = options.spawnDetached ?? systemSpawnDetached;
  const { pid } = spawn({
    cmd: [...options.dipoCommand, "daemon", "worker-host", options.runId],
    cwd: runDir,
    env: { ...detachedEnv(options.env), [RUN_DIR_ENV]: runDir },
    outputFile: join(runDir, HOST_LOG_FILE),
  });
  const info = await options.probe(pid);
  if (info === null || info.zombie) {
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
  };
}

/** Records a started host in `worker_hosts`, in its own write transaction. */
export function recordWorkerHost(office: OfficeHandle, host: LaunchedHost, clock: Clock): void {
  office.immediate(() =>
    office.run(
      `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
         protocol_version, run_dir, event_file, started_at)
       values ($office_id, $run, $agent, $pid, $start, $socket, $protocol, $dir, $events, $now)`,
      {
        run: host.runId,
        agent: host.agentId,
        pid: host.pid,
        start: host.startTimeMs,
        socket: host.socketPath,
        protocol: host.protocolVersion,
        dir: host.runDir,
        events: host.eventFile,
        now: clock.now(),
      },
    ),
  );
}

/** Starts the host for a run and records it (DIPO-74 calls this for a claimed run). */
export async function startWorkerHost(
  office: OfficeHandle,
  clock: Clock,
  options: LaunchWorkerHostOptions,
): Promise<LaunchedHost> {
  const host = await launchWorkerHost(options);
  recordWorkerHost(office, host, clock);
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
  readonly finalOffset: number | null;
  readonly endedAt: number | null;
  readonly mode: "steer" | "follow";
  readonly startedAt: number;
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
  final_offset: number | null;
  ended_at: number | null;
  mode: "steer" | "follow";
  started_at: number;
}

/** The hosts of a run, oldest first. */
export function workerHostsOf(office: OfficeHandle, runId: string): WorkerHostRow[] {
  return office
    .all<RawRow>(
      "select * from worker_hosts where office_id = $office_id and run_id = $run order by started_at, agent_id",
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
      finalOffset: row.final_offset,
      endedAt: row.ended_at,
      mode: row.mode,
      startedAt: row.started_at,
    }));
}

/** Records what `exit.json` says on the host's row. */
export function recordHostExit(office: OfficeHandle, agentId: string, exit: HostExitFile): void {
  office.immediate(() =>
    office.run(
      `update worker_hosts set exit_code = $code, exit_signal = $signal, final_offset = $final,
         ended_at = $at where office_id = $office_id and run_id = $run and agent_id = $agent`,
      {
        code: exit.code,
        signal: exit.signal,
        final: exit.finalOffset,
        at: exit.at,
        run: exit.run,
        agent: agentId,
      },
    ),
  );
}

/**
 * True when the recorded host process still runs: same PID and a start time within the DIPO-23
 * tolerance, not a zombie. The host socket is never consulted.
 */
export async function hostAlive(host: ProcessIdentity, probe: ProcessProbe): Promise<boolean> {
  return isSameProcess(host, await probe(host.pid));
}
