// The client's `lifecycle` module (0006 decisions 2, 5, 6 and 14): the process-level steps that
// cannot use the socket. It starts, stops, restarts and reports the daemon for
// `dipo daemon start|stop|restart|status`, and starts it for any client command that needs it
// unless `daemon.autostart` is false in `<state>/config.yaml` (autostart).
//
// - Status: `dipo.pid` names a live `dipo daemon --foreground` with the same start time (DIPO-23)
//   and its socket answers: running. It is alive but silent for 5 s: unresponsive. Otherwise the
//   daemon is not running, and a leftover `dipo.pid` or `runtime.json` is stale and removed.
// - Start spawns the daemon detached and waits up to 5 s for `engine.hello`.
// - Stop sends `daemon.stop`. `--force`, and a daemon of another contract major, get SIGTERM to the
//   verified PID (every version drains on it); `--force` adds SIGKILL after 10 s. Code never
//   signals a PID whose start time or command does not match the record.

import {
  type Clock,
  type ConfigError,
  ContractUnsupportedDetails,
  daemonStatus,
  daemonStop,
  type Origin,
} from "@dipsaus-orchestrator/contract";
import type { z } from "zod";

import { ClientError, type DipoClient } from "../../client";
import { systemClock } from "../clock";
import { readSoftwareConfig, softwareConfigPath } from "../config";
import { connectToDaemon, DaemonNotRunningError } from "../connect";
import { type Env, logsDir, readRuntimeInfo, stateDir } from "../runtime";
import {
  parsePidRecord,
  pidFilePath,
  type PidRecord,
  readRaw,
  removeIfUnchanged,
  runtimeFilePath,
  runtimeIdentity,
} from "./files";
import { isDaemonCommand, isSameProcess, type ProcessProbe, systemProcessProbe } from "./process";
import { daemonEnv, selfCommand, type SpawnDaemon, systemSpawnDaemon } from "./spawn";

export type DaemonStatusResult = z.output<typeof daemonStatus.result>;

/** What the lifecycle needs from a connection to the daemon. */
export type DaemonSession = Pick<DipoClient, "read" | "command" | "close" | "hello">;

/** Waits, in ms; tests shorten them. The defaults are 0006 decisions 5 and 6. */
export interface LifecycleTimings {
  /** How long a start waits for `engine.hello`, and a live PID may stay silent. */
  readonly startWaitMs: number;
  /** How long one connection attempt or one reply may take. */
  readonly connectTimeoutMs: number;
  readonly pollMs: number;
  /** How long `stop` waits for the PID to exit after `daemon.stop` or SIGTERM (drain cap 20 s). */
  readonly stopWaitMs: number;
  /** `stop --force`: SIGKILL after this long. */
  readonly forceKillAfterMs: number;
  /** After SIGKILL, how long to wait for the PID to be gone. */
  readonly killWaitMs: number;
}

export const LIFECYCLE_TIMINGS: LifecycleTimings = {
  startWaitMs: 5_000,
  connectTimeoutMs: 1_000,
  pollMs: 100,
  stopWaitMs: 30_000,
  forceKillAfterMs: 10_000,
  killWaitMs: 5_000,
};

export interface LifecycleDeps {
  readonly env: Env;
  readonly clock: Clock;
  readonly probe: ProcessProbe;
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly spawn: SpawnDaemon;
  /** How this binary runs itself; `daemon --foreground` is appended. */
  readonly selfCommand: readonly [string, ...string[]];
  /** Connects and completes `engine.hello`; throws `DaemonNotRunningError` or `ClientError`. */
  readonly connect: (timeoutMs?: number) => Promise<DaemonSession>;
  readonly timings: LifecycleTimings;
}

export interface SystemLifecycleOptions {
  readonly client: { readonly name: string; readonly version: string };
  readonly origin: Origin;
  readonly env?: Env;
  readonly clock?: Clock;
}

/** The real processes, files and socket. */
export function systemLifecycleDeps(options: SystemLifecycleOptions): LifecycleDeps {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  return {
    env,
    clock,
    probe: systemProcessProbe(),
    signal: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // Gone already.
      }
    },
    spawn: systemSpawnDaemon,
    selfCommand: selfCommand(),
    connect: async (timeoutMs) => {
      const { client } = await connectToDaemon({
        client: options.client,
        origin: options.origin,
        env,
        clock,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return client;
    },
    timings: LIFECYCLE_TIMINGS,
  };
}

/** What `dipo daemon status` reports (0006 decision 5). */
export type DaemonObservation =
  | {
      readonly kind: "running";
      readonly record: PidRecord;
      readonly status: DaemonStatusResult;
    }
  /** Alive and answering, but it speaks another contract major (0005 section 11). */
  | {
      readonly kind: "foreign";
      readonly record: PidRecord;
      readonly details: ContractUnsupportedDetails | null;
    }
  | { readonly kind: "unresponsive"; readonly record: PidRecord }
  /** `cleaned` lists the stale files removed; non-empty means `stale`. */
  | { readonly kind: "not running"; readonly cleaned: readonly string[] };

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

/** Resolves with `promise`, or with `fallback` after `ms`. */
function within<T>(clock: Clock, promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<Clock["setTimeout"]> | null = null;
  const deadline = new Promise<T>((resolve) => {
    timer = clock.setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== null) clock.clearTimeout(timer);
  });
}

/** True while `record` names a live `dipo daemon --foreground` (PID, start time and command). */
async function isLiveDaemon(deps: LifecycleDeps, record: PidRecord): Promise<boolean> {
  const info = await deps.probe(record.pid);
  return isSameProcess(record, info) && info !== null && isDaemonCommand(info.command);
}

type Answer =
  | { readonly kind: "status"; readonly status: DaemonStatusResult }
  | { readonly kind: "foreign"; readonly details: ContractUnsupportedDetails | null }
  | { readonly kind: "silent" };

/** One attempt: connect, `engine.hello`, then `daemon.status`. */
async function ask(deps: LifecycleDeps): Promise<Answer> {
  let session: DaemonSession;
  try {
    session = await deps.connect(deps.timings.connectTimeoutMs);
  } catch (error) {
    if (error instanceof ClientError && error.code === "contract.unsupported") {
      const details = ContractUnsupportedDetails.safeParse(error.engineError?.details);
      return { kind: "foreign", details: details.success ? details.data : null };
    }
    return { kind: "silent" };
  }
  try {
    const reply = await within(
      deps.clock,
      session.read(daemonStatus, {}).catch(() => null),
      deps.timings.connectTimeoutMs,
      null,
    );
    return reply !== null && reply.ok
      ? { kind: "status", status: reply.result }
      : { kind: "silent" };
  } finally {
    session.close();
  }
}

/**
 * Asks the live daemon of `record` on the socket in `runtime.json`; it gets `startWaitMs` to
 * answer (it may be starting). Null when the process ended meanwhile.
 */
async function handshake(
  deps: LifecycleDeps,
  record: PidRecord,
): Promise<DaemonObservation | null> {
  const { clock, timings } = deps;
  const state = stateDir(deps.env);
  const deadline = clock.now() + timings.startWaitMs;
  for (;;) {
    const runtime = readRuntimeInfo(state);
    // The socket must be the one this process wrote (same PID and start time, DIPO-23).
    if (
      runtime !== null &&
      runtime.pid === record.pid &&
      runtime.startTimeMs === record.startTimeMs
    ) {
      const answer = await ask(deps);
      if (answer.kind === "status") return { kind: "running", record, status: answer.status };
      if (answer.kind === "foreign") return { kind: "foreign", record, details: answer.details };
    }
    if (clock.now() >= deadline) return { kind: "unresponsive", record };
    await sleep(clock, timings.pollMs);
    if (!(await isLiveDaemon(deps, record))) return null;
  }
}

/** Removes the stale lock and `runtime.json`, never a file a live daemon wrote meanwhile. */
async function cleanLeftovers(deps: LifecycleDeps, pidFile: ReturnType<typeof readRaw>) {
  const state = stateDir(deps.env);
  const cleaned: string[] = [];
  if (pidFile !== null && removeIfUnchanged(pidFile)) cleaned.push(pidFile.path);
  // `runtime.json` is stale when `dipo.pid` is missing or failed the check. It is removed unless
  // the process it names is alive with the same start time: a daemon that lost its lock file
  // recreates it within a minute (0006 decision 6), and its socket must stay findable.
  const runtimeFile = readRaw(runtimeFilePath(state));
  if (runtimeFile !== null) {
    const identity = runtimeIdentity(runtimeFile.raw);
    const live = identity !== null && isSameProcess(identity, await deps.probe(identity.pid));
    if (!live && removeIfUnchanged(runtimeFile)) cleaned.push(runtimeFile.path);
  }
  return cleaned;
}

/** Reads `dipo.pid` and the daemon it names: running, foreign, unresponsive or not running. */
export async function inspectDaemon(deps: LifecycleDeps): Promise<DaemonObservation> {
  const { clock, timings } = deps;
  const path = pidFilePath(stateDir(deps.env));
  for (let pass = 0; ; pass++) {
    let pidFile = readRaw(path);
    // An unparsable record is a starter between create and write, or damage: give it the same
    // 5 s a starting daemon gets.
    const deadline = clock.now() + timings.startWaitMs;
    while (pidFile !== null && parsePidRecord(pidFile.raw) === null && clock.now() < deadline) {
      await sleep(clock, timings.pollMs);
      pidFile = readRaw(path);
    }
    const record = pidFile === null ? null : parsePidRecord(pidFile.raw);
    if (record !== null && (await isLiveDaemon(deps, record))) {
      const observed = await handshake(deps, record);
      // The daemon exited while we asked: look again, a few times at most.
      if (observed !== null) return observed;
      if (pass < 2) continue;
    }
    return { kind: "not running", cleaned: await cleanLeftovers(deps, pidFile) };
  }
}

/** Waits up to `ms` for the process of `record` to be gone; true when it is. */
async function waitForExit(deps: LifecycleDeps, record: PidRecord, ms: number): Promise<boolean> {
  const deadline = deps.clock.now() + ms;
  for (;;) {
    if (!isSameProcess(record, await deps.probe(record.pid))) return true;
    if (deps.clock.now() >= deadline) return false;
    await sleep(deps.clock, deps.timings.pollMs);
  }
}

/** SIGTERM or SIGKILL to the PID of `record`, only after the identity check; false when gone. */
async function signalVerified(
  deps: LifecycleDeps,
  record: PidRecord,
  signal: "SIGTERM" | "SIGKILL",
): Promise<boolean> {
  if (!(await isLiveDaemon(deps, record))) return false;
  deps.signal(record.pid, signal);
  return true;
}

export type StartResult =
  | { readonly kind: "started"; readonly pid: number; readonly version: string }
  | { readonly kind: "already running"; readonly pid: number; readonly version: string }
  | { readonly kind: "unresponsive"; readonly pid: number }
  | { readonly kind: "config"; readonly errors: readonly ConfigError[] }
  /** The daemon process ended during the start; its log says why. */
  | { readonly kind: "exited"; readonly pid: number; readonly logs: string }
  | { readonly kind: "timeout"; readonly pid: number; readonly logs: string };

export interface StartOptions {
  readonly logLevel?: string;
}

/** Reads `<state>/config.yaml` the way the daemon will, so a start never ends in exit 78. */
function configProblems(deps: LifecycleDeps): readonly ConfigError[] | null {
  const config = readSoftwareConfig(stateDir(deps.env));
  return config.ok ? null : config.errors;
}

async function spawnAndWait(deps: LifecycleDeps, options: StartOptions): Promise<StartResult> {
  const { clock, timings } = deps;
  const logs = logsDir(deps.env);
  const spawned = await deps.spawn({
    cmd: [
      ...deps.selfCommand,
      "daemon",
      "--foreground",
      ...(options.logLevel === undefined ? [] : ["--log-level", options.logLevel]),
    ],
    env: daemonEnv(deps.env),
  });
  const deadline = clock.now() + timings.startWaitMs;
  for (;;) {
    const answer = await ask(deps);
    if (answer.kind === "status") {
      return { kind: "started", pid: answer.status.pid, version: answer.status.version };
    }
    const info = await deps.probe(spawned.pid);
    if (info === null || info.zombie) {
      // Gone without an answer. Another starter may have won the lock (this one then exits 0):
      // keep asking while dipo.pid names a live daemon; otherwise the start failed.
      const lock = readRaw(pidFilePath(stateDir(deps.env)));
      const record = lock === null ? null : parsePidRecord(lock.raw);
      if (record === null || !(await isLiveDaemon(deps, record))) {
        return { kind: "exited", pid: spawned.pid, logs };
      }
    }
    if (clock.now() >= deadline) return { kind: "timeout", pid: spawned.pid, logs };
    await sleep(clock, timings.pollMs);
  }
}

/** `dipo daemon start` (0006 decision 5). */
export async function startDaemon(
  deps: LifecycleDeps,
  options: StartOptions = {},
): Promise<StartResult> {
  const before = await inspectDaemon(deps);
  if (before.kind === "running") {
    return { kind: "already running", pid: before.status.pid, version: before.status.version };
  }
  if (before.kind === "foreign") {
    return {
      kind: "already running",
      pid: before.record.pid,
      version: before.details?.version ?? before.record.version,
    };
  }
  if (before.kind === "unresponsive") return { kind: "unresponsive", pid: before.record.pid };
  const errors = configProblems(deps);
  if (errors !== null) return { kind: "config", errors };
  return spawnAndWait(deps, options);
}

export type StopResult =
  | { readonly kind: "not running"; readonly cleaned: readonly string[] }
  | { readonly kind: "stopped"; readonly pid: number; readonly killed: boolean }
  | { readonly kind: "unresponsive"; readonly pid: number }
  | { readonly kind: "refused"; readonly pid: number; readonly message: string }
  | { readonly kind: "still running"; readonly pid: number };

/** Stops the daemon `observed` names; `daemon.stop` for the same contract major, else SIGTERM. */
async function stopObserved(
  deps: LifecycleDeps,
  observed: Exclude<DaemonObservation, { kind: "not running" }>,
  force: boolean,
): Promise<StopResult> {
  const { record } = observed;
  const pid = record.pid;
  if (force) {
    if (!(await signalVerified(deps, record, "SIGTERM"))) {
      return { kind: "stopped", pid, killed: false };
    }
    if (await waitForExit(deps, record, deps.timings.forceKillAfterMs)) {
      return { kind: "stopped", pid, killed: false };
    }
    await signalVerified(deps, record, "SIGKILL");
    if (!(await waitForExit(deps, record, deps.timings.killWaitMs))) {
      return { kind: "still running", pid };
    }
    // A killed daemon leaves its lock and runtime.json behind; they are stale now.
    await inspectDaemon(deps);
    return { kind: "stopped", pid, killed: true };
  }
  if (observed.kind === "unresponsive") return { kind: "unresponsive", pid };
  if (observed.kind === "foreign") {
    // Another contract major: SIGTERM does not depend on any contract (0006 decision 14).
    await signalVerified(deps, record, "SIGTERM");
  } else {
    let session: DaemonSession;
    try {
      session = await deps.connect(deps.timings.connectTimeoutMs);
    } catch (error) {
      return {
        kind: "refused",
        pid,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const outcome = await session.command(daemonStop, { stopWorkers: false });
      if (!outcome.ok) {
        return { kind: "refused", pid, message: `${outcome.error.code}: ${outcome.error.message}` };
      }
    } catch (error) {
      // The daemon may close the connection as it drains; the PID check below decides.
      if (!(error instanceof ClientError)) throw error;
    } finally {
      session.close();
    }
  }
  if (await waitForExit(deps, record, deps.timings.stopWaitMs)) {
    // A clean exit removes dipo.sock and dipo.pid (0006 decision 6) but leaves runtime.json,
    // which is stale now; removing it here keeps the next `status` at `not running`.
    await inspectDaemon(deps);
    return { kind: "stopped", pid, killed: false };
  }
  return { kind: "still running", pid };
}

/** `dipo daemon stop [--force]` (0006 decision 5). */
export async function stopDaemon(
  deps: LifecycleDeps,
  options: { readonly force?: boolean } = {},
): Promise<StopResult> {
  const observed = await inspectDaemon(deps);
  if (observed.kind === "not running") return observed;
  return stopObserved(deps, observed, options.force === true);
}

export type RestartResult =
  | { readonly kind: "stop failed"; readonly stop: StopResult }
  | { readonly kind: "config"; readonly errors: readonly ConfigError[] }
  | { readonly kind: "restarted"; readonly stopped: number | null; readonly start: StartResult };

/**
 * `dipo daemon restart` (0006 decision 14): stops the running daemon (`daemon.stop` for the same
 * contract major, verified-PID SIGTERM for another), waits for its PID to exit, then starts this
 * binary. An invalid `config.yaml` refuses before anything is stopped.
 */
export async function restartDaemon(
  deps: LifecycleDeps,
  options: StartOptions = {},
): Promise<RestartResult> {
  const errors = configProblems(deps);
  if (errors !== null) return { kind: "config", errors };
  const observed = await inspectDaemon(deps);
  let stopped: number | null = null;
  if (observed.kind !== "not running") {
    const stop = await stopObserved(deps, observed, false);
    if (stop.kind !== "stopped") return { kind: "stop failed", stop };
    stopped = stop.pid;
  }
  return { kind: "restarted", stopped, start: await startDaemon(deps, options) };
}

/** Autostart is off: `daemon.autostart: false` in `<state>/config.yaml`. */
export class AutostartOffError extends Error {
  constructor(readonly configPath: string) {
    super(
      `no daemon is running and daemon.autostart is false in ${configPath}. Start it with \`dipo daemon start\`.`,
    );
    this.name = "AutostartOffError";
  }
}

/** `<state>/config.yaml` is invalid, so a started daemon would exit 78 (DIPO-69). */
export class SoftwareConfigError extends Error {
  constructor(readonly errors: readonly ConfigError[]) {
    super(
      `cannot start the daemon: ${errors.map((error) => error.message).join("; ")}. Fix the file, then run \`dipo daemon start\`.`,
    );
    this.name = "SoftwareConfigError";
  }
}

/** The autostart did not end in a running daemon. */
export class DaemonStartError extends Error {
  constructor(readonly result: StartResult) {
    super(describeStartFailure(result));
    this.name = "DaemonStartError";
  }
}

/** One line for a start that did not succeed. */
export function describeStartFailure(result: StartResult): string {
  switch (result.kind) {
    case "unresponsive":
      return `the daemon (pid ${result.pid}) holds the lock but does not answer. Run \`dipo daemon stop --force\` to stop it.`;
    case "config":
      return `cannot start the daemon: ${result.errors.map((error) => error.message).join("; ")}`;
    case "exited":
      return `the daemon (pid ${result.pid}) exited during its start; see ${result.logs}/daemon.log`;
    case "timeout":
      return `the daemon (pid ${result.pid}) did not answer within 5 s; see ${result.logs}/daemon.log and \`dipo daemon status\``;
    default:
      return `the daemon is running (pid ${result.pid}, version ${result.version})`;
  }
}

export interface ConnectedDaemon {
  readonly session: DaemonSession;
  /** Set when this call started the daemon. */
  readonly started: { readonly pid: number; readonly version: string } | null;
}

/**
 * Connects for a client command that needs the daemon, and starts it first when none runs and
 * `daemon.autostart` is not false (0006 decision 5). The configuration is read before the start,
 * and its errors are thrown instead of starting a daemon that would exit 78.
 */
export async function connectOrStart(deps: LifecycleDeps): Promise<ConnectedDaemon> {
  try {
    return { session: await deps.connect(), started: null };
  } catch (error) {
    if (!(error instanceof DaemonNotRunningError)) throw error;
  }
  const state = stateDir(deps.env);
  const config = readSoftwareConfig(state);
  if (!config.ok) throw new SoftwareConfigError(config.errors);
  if (!config.config.daemon.autostart) throw new AutostartOffError(softwareConfigPath(state));
  const result = await startDaemon(deps);
  if (result.kind !== "started" && result.kind !== "already running") {
    throw new DaemonStartError(result);
  }
  const session = await deps.connect();
  return {
    session,
    started: result.kind === "started" ? { pid: result.pid, version: result.version } : null,
  };
}

/**
 * The hint of 0006 decision 14 when this binary and the daemon differ, else null.
 */
export function versionHint(own: string, daemon: string | undefined): string | null {
  if (daemon === undefined || daemon === own) return null;
  return `daemon runs v${daemon}, this binary is v${own}, run \`dipo daemon restart\``;
}
