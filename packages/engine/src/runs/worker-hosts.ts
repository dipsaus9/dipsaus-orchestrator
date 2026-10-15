// Starting a worker host and recording it (0006 decision 8, 0007 sections 2 and 4). The engine
// writes `launch.json` into the run directory, starts `dipo daemon worker-host <run-id>` detached
// with stdio appended to `host.log` and `BUN_OPTIONS` removed, reads the host's start time and
// records PID, start time, socket path and host protocol version in `worker_hosts`. Hosts are not
// daemon children (`ChildProcesses`): a drain leaves them running.
//
// The row is written pending before the spawn and completed after it (DIPO-93), so a restart in
// between finds the host through its claimed launch or PID marker and never starts a second one.
//
// Liveness is PID plus start time through the DIPO-23 identity check, where a zombie is dead;
// the socket is never asked (0006 decision 8).

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import {
  EVENTS_FILE,
  EXIT_FILE,
  HOST_LOG_FILE,
  HOST_PROTOCOL_VERSION,
  HostExitFileSchema,
  HostMarkerSchema,
  hostMarkerName,
  HOSTS_DIR,
  hostSocketPath,
  LAUNCH_FILE,
  REVOKED_LAUNCH_FILE,
  RUN_ID_PATTERN,
  type HostExitFile,
  type HostLaunch,
} from "../host/protocol";
import { ensurePrivateDir, type Env } from "../platform/paths";
import {
  detachedEnv,
  isSameProcess,
  isWorkerHostCommand,
  START_TIME_TOLERANCE_MS,
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
  hooks.beforeSpawn?.({
    runId: options.runId,
    agentId: options.agentId,
    socketPath,
    protocolVersion: HOST_PROTOCOL_VERSION,
    runDir,
    eventFile: join(runDir, EVENTS_FILE),
    engineToken,
  });
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
         protocol_version, run_dir, event_file, processed_offset, started_at, engine_token,
         signal_stop)
       values ($office_id, $run, $agent, $pid, $start, $socket, $protocol, $dir, $events,
         $offset, $now, $token, 1)
       on conflict (office_id, run_id, agent_id) do update set pid = excluded.pid,
         start_time_ms = excluded.start_time_ms, socket_path = excluded.socket_path,
         protocol_version = excluded.protocol_version, run_dir = excluded.run_dir,
         event_file = excluded.event_file, processed_offset = excluded.processed_offset,
         engine_token = excluded.engine_token, signal_stop = 1, pending = 0`,
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

/**
 * Records a host before it is spawned (DIPO-93): a `worker_hosts` row with `pending` set and PID
 * and start time 0. Ingestion, steering and re-attach read it as the run's newest host, so a
 * restart between the spawn and `recordWorkerHost` finds it and never starts a second one.
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
         protocol_version, run_dir, event_file, processed_offset, started_at, engine_token,
         signal_stop, pending)
       values ($office_id, $run, $agent, 0, 0, $socket, $protocol, $dir, $events, $offset, $now,
         $token, 1, 1)`,
      {
        run: host.runId,
        agent: host.agentId,
        socket: host.socketPath,
        protocol: host.protocolVersion,
        dir: host.runDir,
        events: host.eventFile,
        offset: processedOffset,
        now: clock.now(),
        token: host.engineToken ?? null,
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
  readonly mode: "steer" | "follow";
  readonly startedAt: number;
  /** The engine's secret for this host; null for a host started before DIPO-59. */
  readonly engineToken: string | null;
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
  mode: "steer" | "follow";
  started_at: number;
  engine_token: string | null;
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
      mode: row.mode,
      startedAt: row.started_at,
      engineToken: row.engine_token,
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

// ---- pending hosts after a restart (DIPO-93) ----------------------------------------------------

/** The host's PID marker for `agent` in `runDir`, or null when it is missing or not for the run. */
export function readHostMarker(runDir: string, runId: string, agentId: string): number | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(runDir, hostMarkerName(agentId)), "utf8"));
  } catch {
    return null;
  }
  const parsed = HostMarkerSchema.safeParse(raw);
  if (!parsed.success || parsed.data.run !== runId || parsed.data.agent !== agentId) return null;
  return parsed.data.pid;
}

/**
 * How long after its pending row is written a host process can have started (DIPO-93): the row is
 * written right before the spawn, and the spawn returns at once. A process that started later is
 * not the host, whatever its command says.
 */
export const SPAWN_WINDOW_MS = 5_000;

const CLAIMED_PREFIX = `${LAUNCH_FILE}.claimed.`;

/** A launch file a host claimed for `agent` but has not removed yet: its PID and path. */
function claimedLaunch(
  runDir: string,
  runId: string,
  agentId: string,
): { pid: number; path: string } | null {
  let names: string[];
  try {
    names = readdirSync(runDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.startsWith(CLAIMED_PREFIX)) continue;
    const pid = Number(name.slice(CLAIMED_PREFIX.length));
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const path = join(runDir, name);
    try {
      const launch = JSON.parse(readFileSync(path, "utf8")) as { run?: unknown; agent?: unknown };
      if (launch.run === runId && launch.agent === agentId) return { pid, path };
    } catch {
      // Removed meanwhile, or not a launch: not this host's.
    }
  }
  return null;
}

/** What `resolvePendingHost` did with a pending row. */
export type PendingResolution =
  /** A host claimed the launch: the row now names its PID (alive, or dead to be closed out). */
  | { readonly kind: "recorded"; readonly pid: number; readonly alive: boolean }
  /** No host ever claimed the launch: it was revoked and the row removed; nothing ran. */
  | { readonly kind: "revoked" };

/**
 * Settles a `worker_hosts` row that was still pending when the daemon stopped (DIPO-93). The host
 * names itself first by the claimed launch file, then by its PID marker (`readLaunch`), so:
 *
 * 1. A marker for the row's agent gives the PID.
 * 2. Otherwise the engine revokes the launch by renaming `launch.json` away: when that succeeds no
 *    host can claim it any more, nothing ran, and the row is removed.
 * 3. When there was no `launch.json` to revoke, a host claimed it (or none was ever written): a
 *    claimed file, then the marker again, give the PID; with neither nothing ran.
 *
 * A PID is taken as the host only when the process runs `dipo daemon worker-host <run>` and
 * started inside the spawn window (from the row's write to `SPAWN_WINDOW_MS` later, each end widened by the start-time tolerance); its start time is then recorded. Any other PID
 * (gone, reused) is recorded with start time 0, which never matches a living process, so the
 * host is closed out as dead (`exit.json` or lost).
 */
export async function resolvePendingHost(
  office: OfficeHandle,
  host: WorkerHostRow,
  probe: ProcessProbe,
): Promise<PendingResolution> {
  const { runDir, runId, agentId } = host;
  let pid = readHostMarker(runDir, runId, agentId);
  let claimed: string | null = null;
  if (pid === null) {
    const revoked = join(runDir, REVOKED_LAUNCH_FILE);
    let revokedNow = false;
    try {
      renameSync(join(runDir, LAUNCH_FILE), revoked);
      revokedNow = true;
    } catch {
      // No launch.json: a host claimed it, or none was written.
    }
    // A launch the engine had not finished writing never reached a host either.
    rmSync(join(runDir, `${LAUNCH_FILE}.tmp`), { force: true });
    if (revokedNow) {
      rmSync(revoked, { force: true });
      deletePendingHost(office, runId, agentId);
      return { kind: "revoked" };
    }
    // The claimed file first: the host writes its marker before it removes that file.
    const found = claimedLaunch(runDir, runId, agentId);
    pid = found?.pid ?? readHostMarker(runDir, runId, agentId);
    claimed = found?.path ?? null;
    if (pid === null) {
      deletePendingHost(office, runId, agentId);
      return { kind: "revoked" };
    }
  }
  const info = await probe(pid);
  const alive =
    info !== null &&
    !info.zombie &&
    info.pid === pid &&
    isWorkerHostCommand(info.command, runId) &&
    info.startTimeMs >= host.startedAt - START_TIME_TOLERANCE_MS &&
    info.startTimeMs <= host.startedAt + SPAWN_WINDOW_MS + START_TIME_TOLERANCE_MS;
  // A dead host's claimed launch still holds the task message: it never stays.
  if (!alive && claimed !== null) rmSync(claimed, { force: true });
  office.immediate(() =>
    office.run(
      `update worker_hosts set pid = $pid, start_time_ms = $start, pending = 0
        where office_id = $office_id and run_id = $run and agent_id = $agent and pending = 1`,
      { pid, start: alive && info !== null ? info.startTimeMs : 0, run: runId, agent: agentId },
    ),
  );
  return { kind: "recorded", pid, alive };
}

/** Whether dipo may signal a followed host (DIPO-93), and why not. */
export type SignalCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const no = (reason: string): SignalCheck => ({ ok: false, reason });

/**
 * The checks before the engine signals a follow-only host (DIPO-93, ADR 0006/0008 amendment):
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
