// Starting a worker host and recording it (0006 decision 8, 0007 sections 2 and 4). The engine
// writes `launch.json` into the run directory, starts `dipo daemon worker-host <run-id>` detached
// with stdio appended to `host.log` and `BUN_OPTIONS` removed, reads the host's start time and
// records PID, start time, socket path and host protocol version in `worker_hosts`. Hosts are not
// daemon children (`ChildProcesses`): a drain leaves them running.
//
// The row is written pending before the spawn and completed after it (DIPO-93), so a restart in
// between finds the row: re-attach asks the row's socket for the host's PID, or parks the story when
// no live host matches it (0005).
//
// Liveness is PID plus start time through the DIPO-23 identity check, where a zombie is dead;
// the socket is never asked (0006 decision 8).
//
// This module is the one writer of `worker_hosts` (0001): every insert, update and delete of a
// host row goes through it, and `test/run/one-writer.test.ts` fails on one anywhere else.

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
  isWorkerHostCommand,
  systemSpawnDetached,
  type ProcessIdentity,
  type ProcessProbe,
  type SignalProcess,
  type SpawnDetached,
} from "../platform/process";
import { ofNoOpenRun } from "../run/retired";
import type { ExitRecord, LaunchPlan } from "../workers/types";

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

/** A host about to be spawned: everything but its PID and start time (DIPO-93). */
export type PendingHost = Omit<LaunchedHost, "pid" | "startTimeMs">;

export interface LaunchHooks {
  /**
   * Called before `launch.json` is written and the host is spawned (DIPO-93): the engine records
   * the pending `worker_hosts` row here, so a restart from now on finds the host.
   */
  readonly beforeSpawn?: (host: PendingHost) => void;
}

/** Writes `launch.json` and starts the host detached; resolves with its identity. */
export async function launchWorkerHost(
  options: LaunchWorkerHostOptions,
  hooks: LaunchHooks = {},
): Promise<LaunchedHost> {
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
  hooks.beforeSpawn?.({
    runId: options.runId,
    agentId: options.agentId,
    socketPath,
    protocolVersion: HOST_PROTOCOL_VERSION,
    runDir,
    eventFile: join(runDir, EVENTS_FILE),
  });
  const launchPath = join(runDir, LAUNCH_FILE);
  writeFileSync(`${launchPath}.tmp`, JSON.stringify(launch), { mode: 0o600 });
  renameSync(`${launchPath}.tmp`, launchPath);

  const spawn = options.spawnDetached ?? systemSpawnDetached;
  // launch.json holds the task message: it never stays behind when the host did not start.
  let pid: number;
  let info: Awaited<ReturnType<ProcessProbe>>;
  try {
    ({ pid } = spawn({
      cmd: [...options.dipoCommand, "daemon", "worker-host", options.runId],
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
  };
}

/** What is recorded together with a started host, in the same transaction (DIPO-57). */
export interface HostRecordExtras {
  /** Where ingestion of the host starts in the run's event file; 0 by default. */
  readonly processedOffset?: number;
  /** Writes that belong with the host row (the new agent), run inside the same transaction. */
  readonly record?: () => void;
}

/**
 * Records a started host in `worker_hosts`, in its own write transaction. A pending row of the same
 * host (`recordPendingHost`) becomes the recorded host, keeping its `started_at`. Every host this
 * binary starts stops its worker on SIGTERM (`signal_stop`, DIPO-93).
 */
export function recordWorkerHost(
  office: OfficeHandle,
  host: LaunchedHost,
  clock: Clock,
  extras: HostRecordExtras = {},
): void {
  office.immediate(() => {
    office.run(
      `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
         protocol_version, run_dir, event_file, processed_offset, started_at, signal_stop)
       values ($office_id, $run, $agent, $pid, $start, $socket, $protocol, $dir, $events,
         $offset, $now, 1)
       on conflict (office_id, run_id, agent_id) do update set pid = excluded.pid,
         start_time_ms = excluded.start_time_ms, socket_path = excluded.socket_path,
         protocol_version = excluded.protocol_version, run_dir = excluded.run_dir,
         event_file = excluded.event_file, processed_offset = excluded.processed_offset,
         signal_stop = 1, pending = 0`,
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
      },
    );
    extras.record?.();
  });
}

/**
 * Records a host before it is spawned (DIPO-93): a `worker_hosts` row with `pending` set and PID
 * and start time 0. Ingestion, steering and re-attach read it as the run's newest host, so a
 * restart between the spawn and `recordWorkerHost` finds it: re-attach records the host its socket
 * names, or parks the story when no live host matches (0005); it never starts a second one.
 */
export function recordPendingHost(
  office: OfficeHandle,
  host: PendingHost,
  clock: Clock,
  processedOffset = 0,
): void {
  office.immediate(() =>
    office.run(
      `insert into worker_hosts (office_id, run_id, agent_id, pid, start_time_ms, socket_path,
         protocol_version, run_dir, event_file, processed_offset, started_at, signal_stop, pending)
       values ($office_id, $run, $agent, 0, 0, $socket, $protocol, $dir, $events, $offset, $now,
         1, 1)`,
      {
        run: host.runId,
        agent: host.agentId,
        socket: host.socketPath,
        protocol: host.protocolVersion,
        dir: host.runDir,
        events: host.eventFile,
        offset: processedOffset,
        now: clock.now(),
      },
    ),
  );
}

/** Removes a host row that is still pending: its host never started. */
export function deletePendingHost(office: OfficeHandle, runId: string, agentId: string): void {
  office.immediate(() =>
    office.run(
      `delete from worker_hosts where office_id = $office_id and run_id = $run
         and agent_id = $agent and pending = 1`,
      { run: runId, agent: agentId },
    ),
  );
}

/**
 * Starts the host for a run and records it (DIPO-74 calls this for a claimed run). The row is
 * written pending before the spawn (DIPO-93) and completed after it; a start that fails removes it.
 */
export async function startWorkerHost(
  office: OfficeHandle,
  clock: Clock,
  options: LaunchWorkerHostOptions,
  extras: HostRecordExtras = {},
): Promise<LaunchedHost> {
  let pending = false;
  let host: LaunchedHost;
  try {
    host = await launchWorkerHost(options, {
      beforeSpawn: (about) => {
        recordPendingHost(office, about, clock, extras.processedOffset ?? 0);
        pending = true;
      },
    });
  } catch (error) {
    if (pending) deletePendingHost(office, options.runId, options.agentId);
    throw error;
  }
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
  readonly startedAt: number;
  /** Written before its spawn; PID and start time are 0 until it is recorded (DIPO-93). */
  readonly pending: boolean;
  /** The host stops its worker on SIGTERM; false for a host an older binary started (DIPO-93). */
  readonly signalStop: boolean;
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
  started_at: number;
  pending: number;
  signal_stop: number;
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
      startedAt: row.started_at,
      pending: row.pending === 1,
      signalStop: row.signal_stop === 1,
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

/**
 * Inside the caller's transaction: the exit an ingested exit line reports, and the offset the
 * line ends at as the host's final offset, on the host's row, where `exit.json` did not record
 * them first.
 */
export function recordExitLine(
  office: OfficeHandle,
  runId: string,
  agentId: string,
  exit: ExitRecord,
  finalOffset: number,
): void {
  office.run(
    `update worker_hosts set exit_code = coalesce(exit_code, $code),
       exit_signal = coalesce(exit_signal, $signal),
       exit_signal_inferred = case when exit_signal is null then $inferred
         else exit_signal_inferred end,
       final_offset = coalesce(final_offset, $final)
     where office_id = $office_id and run_id = $run and agent_id = $agent`,
    {
      code: exit.code,
      signal: exit.signal,
      inferred: exit.signalInferred === true ? 1 : 0,
      final: finalOffset,
      run: runId,
      agent: agentId,
    },
  );
}

/** Inside the caller's transaction: the host's events are processed up to `offset`. */
export function setProcessedOffset(
  office: OfficeHandle,
  runId: string,
  agentId: string,
  offset: number,
): void {
  office.run(
    `update worker_hosts set processed_offset = $offset
      where office_id = $office_id and run_id = $run and agent_id = $agent`,
    { offset, run: runId, agent: agentId },
  );
}

/** Inside the caller's transaction: the host's row ends at `at`, unless it ended before. */
export function endHostRow(office: OfficeHandle, runId: string, agentId: string, at: number): void {
  office.run(
    `update worker_hosts set ended_at = coalesce(ended_at, $at)
      where office_id = $office_id and run_id = $run and agent_id = $agent`,
    { at, run: runId, agent: agentId },
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

/**
 * Records the live host a pending row stands for (0005): re-attach found it on the row's socket and
 * checked its command and start time.
 */
export function recordPendingPid(
  office: OfficeHandle,
  host: Pick<WorkerHostRow, "runId" | "agentId">,
  pid: number,
  startTimeMs: number,
): void {
  office.immediate(() =>
    office.run(
      `update worker_hosts set pid = $pid, start_time_ms = $start, pending = 0
        where office_id = $office_id and run_id = $run and agent_id = $agent and pending = 1`,
      { pid, start: startTimeMs, run: host.runId, agent: host.agentId },
    ),
  );
}

/** Whether dipo may signal a host (0005), and why not. */
export type SignalCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const no = (reason: string): SignalCheck => ({ ok: false, reason });

/**
 * The checks before the engine signals a host whose socket did not answer after a restart (0005):
 * the row is recorded (not pending) and not ended, the host stops its worker on SIGTERM
 * (`signal_stop`), no `exit.json` past the processed offset says it exited, and the PID is
 * alive with the recorded start time and runs `dipo daemon worker-host <run>`. Any doubt refuses:
 * an unverified PID is never signalled.
 */
export async function verifyHostForSignal(
  host: WorkerHostRow,
  probe: ProcessProbe,
): Promise<SignalCheck> {
  if (host.pending) return no("its row is still pending, so its PID is not known");
  if (host.endedAt !== null) return no("it has ended");
  if (!host.signalStop) {
    return no("it was started by an older dipo that does not stop its worker on SIGTERM");
  }
  if (host.pid <= 1 || host.startTimeMs <= 0) return no("its PID or start time is not recorded");
  if (exitFileOf(host) !== null) return no("its exit.json says it has exited");
  const info = await probe(host.pid);
  if (info === null) return no("the process is gone");
  if (!isSameProcess(host, info)) {
    return no("the process has another start time or is a zombie (the PID may have been reused)");
  }
  if (!isWorkerHostCommand(info.command, host.runId)) {
    return no(`the process does not run \`dipo daemon worker-host ${host.runId}\``);
  }
  return { ok: true };
}

/**
 * One SIGTERM to the host's PID alone, once `verifyHostForSignal` passed (0005): the host then
 * closes its worker's stdin, sends it SIGTERM and SIGKILL 20 s later, and writes `exit.json` as
 * always. Any doubt refuses, and nothing is signalled. Returns null when it was sent, else why not.
 */
export async function signalVerifiedHost(
  host: WorkerHostRow,
  probe: ProcessProbe,
  signal: SignalProcess,
): Promise<string | null> {
  const check = await verifyHostForSignal(host, probe);
  if (!check.ok) return check.reason;
  if (!signal(host.pid, "SIGTERM")) {
    return "the SIGTERM to the verified host was refused or it had just exited";
  }
  return null;
}

/**
 * Retention (0007): deletes at most `limit` worker host rows that ended before `cutoff` and whose
 * run may not reopen (`ofNoOpenRun`), inside the caller's transaction; returns how many it deleted.
 */
export function deleteRetiredHosts(office: OfficeHandle, cutoff: number, limit: number): number {
  return office.run(
    `delete from worker_hosts where rowid in (select rowid from worker_hosts
       where office_id = $office_id and ended_at < $cutoff and ${ofNoOpenRun("worker_hosts")}
       limit $limit)`,
    { cutoff, limit },
  ).changes;
}
