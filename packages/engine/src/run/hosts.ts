// The real `HostStarter` and `RunIngest` the daemon gives the run launcher (DIPO-74). The host is
// started detached through DIPO-44's `startWorkerHost` and recorded in `worker_hosts`; its events
// are ingested through one DIPO-45 `Ingestor` per office: a first pass and the 1 s `stat` poll at
// once, and the host's `advanced` announcements as soon as its socket answers.

import type { Clock, OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import {
  connectHost,
  type ConnectHostResult,
  type HostClient,
  type HostRequest,
} from "../host/client";
import { Ingestor, type IngestHooks, type IngestTarget, type PassResult } from "../ingest/ingestor";
import type { OutputPrivacy } from "../ingest/output";
import type { Env } from "../platform/paths";
import type { ProcessProbe, SignalProcess, SpawnDetached } from "../platform/process";
import { CostDriftWarnings } from "../pricing/drift";
import type { PriceBook } from "../pricing/estimate";
import type { HostOp, WorkerEvent } from "../workers/types";
import {
  type LaunchedHost,
  startWorkerHost,
  verifyHostForSignal,
  type WorkerHostRow,
  workerHostsOf,
} from "../runs/worker-hosts";

import type { RunSteering } from "./control";
import type { HostStarter, RunIngest } from "./launch";
import type { Watchdog } from "./watchdog";

/** How long the engine waits for a new host's socket before it relies on the poll alone. */
export const HOST_CONNECT_TIMEOUT_MS = 5_000;

/** How long the engine waits between connection attempts while a new host has not bound its socket. */
export const HOST_CONNECT_RETRY_MS = 25;

export interface SystemHostStarterOptions {
  readonly clock: Clock;
  readonly runtimeDir: string;
  /** How to run `dipo` (`selfCommand()`). */
  readonly dipoCommand: readonly [string, ...string[]];
  /** The daemon's environment; the host gets it without `BUN_OPTIONS`. */
  readonly env: Env;
  readonly probe: ProcessProbe;
  readonly spawnDetached?: SpawnDetached;
}

/** Starts worker hosts as detached `dipo daemon worker-host <run-id>` processes. */
export function systemHostStarter(options: SystemHostStarterOptions): HostStarter {
  return {
    start: (office, run) =>
      startWorkerHost(
        office,
        options.clock,
        {
          runId: run.runId,
          agentId: run.agentId,
          officeDir: run.officeDir,
          runtimeDir: options.runtimeDir,
          plan: run.plan,
          dipoCommand: options.dipoCommand,
          env: options.env,
          probe: options.probe,
          ...(options.spawnDetached === undefined ? {} : { spawnDetached: options.spawnDetached }),
        },
        {
          ...(run.processedOffset === undefined ? {} : { processedOffset: run.processedOffset }),
          ...(run.record === undefined ? {} : { record: run.record }),
        },
      ),
  };
}

export interface OfficeIngestOptions {
  readonly clock: Clock;
  /** The pricing catalog (`StateDatabase.pricing`), read when an office's ingestor is made. */
  readonly pricing: () => PriceBook | null;
  readonly hooks?: IngestHooks;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /**
   * The watchdog of every run this starts (DIPO-52): it watches a story run from its start, hears
   * of each line, and stops at the worker's exit.
   */
  readonly watchdog?: Watchdog;
  /** Ingestion appended change-log entries for `office`; the daemon sends them to subscribers. */
  readonly onAppended?: (office: OfficeId) => void;
  /**
   * The permission wait (DIPO-59): it hears every committed pass's worker events and every
   * worker exit with the run's office.
   */
  readonly hookEvents?: OfficeRunListener;
  /**
   * The privacy opt-ins in force for `office` (0007 section 8, DIPO-83), read at every ingest pass.
   * Without it, or for an office without a configuration, nothing beyond the default is stored.
   */
  readonly privacy?: (office: OfficeId) => OutputPrivacy;
  /**
   * Rewrites a pass's output text before it is stored (`IngestorOptions.redactOutput`): the web
   * check redacts env values from web lines (0020 section 11b, DIPO-164).
   */
  readonly redactOutput?: (office: OfficeHandle, run: string, text: string) => string;
}

/** Hears a run's worker events and its exit together with the run's office (DIPO-59). */
export interface OfficeRunListener {
  onWorkerEvents(
    office: OfficeHandle,
    run: string,
    agent: string,
    events: readonly WorkerEvent[],
  ): void;
  onEnded(office: OfficeHandle, run: string): void;
}

/** One `Ingestor` per office, made on the office's first started run. */
export class OfficeIngest implements RunIngest {
  readonly #options: OfficeIngestOptions;
  readonly #ingestors = new Map<OfficeId, Ingestor>();
  /** One per daemon, so a drifting model is warned about once per day across offices (DIPO-89). */
  readonly #costDrift = new CostDriftWarnings();

  constructor(options: OfficeIngestOptions) {
    this.#options = options;
  }

  #ingestor(office: OfficeHandle): Ingestor {
    let ingestor = this.#ingestors.get(office.officeId);
    if (ingestor === undefined) {
      const privacyOf = this.#options.privacy;
      const redact = this.#options.redactOutput;
      ingestor = new Ingestor({
        office,
        clock: this.#options.clock,
        pricing: this.#options.pricing(),
        hooks: this.#hooksFor(office),
        costDrift: this.#costDrift,
        ...(redact === undefined
          ? {}
          : { redactOutput: (run: string, text: string) => redact(office, run, text) }),
        ...(privacyOf === undefined ? {} : { privacy: () => privacyOf(office.officeId) }),
        ...(this.#options.warn === undefined ? {} : { warn: this.#options.warn }),
      });
      this.#ingestors.set(office.officeId, ingestor);
    }
    return ingestor;
  }

  /** The caller's hooks, with the watchdog and `onAppended` added. */
  #hooksFor(handle: OfficeHandle): IngestHooks {
    const office = handle.officeId;
    const hooks = this.#options.hooks ?? {};
    const { watchdog, onAppended, hookEvents } = this.#options;
    return {
      ...hooks,
      onLines: (run, agent) => {
        watchdog?.lineSeen(run);
        hooks.onLines?.(run, agent);
      },
      onWorkerEvents: (run, agent, events) => {
        hooks.onWorkerEvents?.(run, agent, events);
        hookEvents?.onWorkerEvents(handle, run, agent, events);
      },
      onEnded: (run, agent, end) => {
        watchdog?.untrack(run);
        hookEvents?.onEnded(handle, run);
        hooks.onEnded?.(run, agent, end);
      },
      onAppended: () => {
        onAppended?.(office);
        hooks.onAppended?.();
      },
    };
  }

  /**
   * Follows a host again after a daemon restart (DIPO-57): catches up from the processed offset
   * at once, then follows `client`'s `advanced` announcements when the host answered, with the
   * 1 s poll in every case. Returns the catch-up pass.
   */
  attach(
    office: OfficeHandle,
    host: Pick<LaunchedHost, "runId" | "agentId">,
    target: IngestTarget,
    client: HostClient | null,
  ): PassResult {
    const ingestor = this.#ingestor(office);
    if (target.work !== undefined) this.#options.watchdog?.track(office, host.runId as RunId);
    const result = ingestor.track(target);
    if (client !== null && result.status !== "ended" && result.status !== "fileChanged") {
      void ingestor.watch(host.runId, host.agentId, client).catch((error: unknown) => {
        this.#options.warn?.("watching the worker host failed; ingestion polls", {
          run: host.runId,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      client?.close();
    }
    return result;
  }

  /** Stops following one agent of a run whose host is gone (DIPO-57); what it ingested stays. */
  untrack(office: OfficeId, run: string, agent: string): void {
    this.#options.watchdog?.untrack(run);
    this.#ingestors.get(office)?.untrack(run, agent);
  }

  start(office: OfficeHandle, host: LaunchedHost, target: IngestTarget): void {
    const ingestor = this.#ingestor(office);
    if (target.work !== undefined) this.#options.watchdog?.track(office, host.runId as RunId);
    ingestor.track(target);
    void this.#connectWhenBound(host)
      .then(async (connected) => {
        // Without the socket the 1 s poll keeps ingesting.
        if (connected.ok) await ingestor.watch(host.runId, host.agentId, connected.client);
      })
      .catch((error: unknown) => {
        this.#options.warn?.("watching the worker host failed; ingestion polls", {
          run: host.runId,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * Connects to a new host's socket, trying again until it is bound. `start` runs right after the
   * detached host was spawned, and the host binds its socket a moment later (DIPO-181): one attempt
   * made then found no socket ("unreachable"), the engine never watched the host, and the host
   * answered every waiting PermissionRequest call at once with no decision. Only "unreachable"
   * is retried, up to `HOST_CONNECT_TIMEOUT_MS`; a refusal or a silent socket ends it.
   */
  async #connectWhenBound(host: LaunchedHost): Promise<ConnectHostResult> {
    const { clock } = this.#options;
    const deadline = clock.now() + HOST_CONNECT_TIMEOUT_MS;
    for (;;) {
      const left = deadline - clock.now();
      const connected = await connectHost(host.socketPath, {
        runId: host.runId,
        clock,
        timeoutMs: Math.max(1, left),
        // The engine's watch: only it may answer hook calls and count as the daemon being up.
        token: host.engineToken ?? null,
      });
      if (connected.ok || connected.reason !== "unreachable") return connected;
      if (deadline - clock.now() <= HOST_CONNECT_RETRY_MS) return connected;
      await new Promise<void>((resolve) => clock.setTimeout(resolve, HOST_CONNECT_RETRY_MS));
    }
  }

  /** Writes the run's pending `work.output` now, before a state change of the run (0005 section 6). */
  flushOutput(office: OfficeId, run: string): void {
    this.#ingestors.get(office)?.flushOutput(run);
  }

  /** Stops every ingestor's and the watchdog's timers; what they ingested is stored. */
  close(): void {
    this.#options.watchdog?.close();
    for (const ingestor of this.#ingestors.values()) ingestor.close();
    this.#ingestors.clear();
  }
}

/** The host socket request that carries one host op. */
export function hostRequestOf(op: HostOp): HostRequest {
  if ("write" in op) return { op: "write", data: op.write };
  if ("closeStdin" in op) return { op: "closeStdin" };
  if ("hookReply" in op) return { op: "hookReply", hook: op.hookReply, output: op.output };
  return op.afterMs === undefined
    ? { op: "signal", signal: op.signal }
    : { op: "signal", signal: op.signal, afterMs: op.afterMs };
}

/** Why a follow-only host cannot be steered (0006 decision 8, 0009 section 3). */
export function followOnlyReason(pid: number): string {
  return `the worker host (pid ${pid}) runs in follow-only mode after a daemon restart: its socket did not answer, so dipo follows its output until it exits but cannot steer it`;
}

/** How long a steering op waits for the host's socket and reply. */
export const STEER_TIMEOUT_MS = 5_000;

/** How often steering looks again at a host row that is still pending (DIPO-93). */
export const PENDING_POLL_MS = 50;

/** True when the ops end the worker: they carry SIGTERM or SIGKILL (the stop sequence). */
export function isStopSequence(ops: readonly HostOp[]): boolean {
  return ops.some((op) => "signal" in op && (op.signal === "SIGTERM" || op.signal === "SIGKILL"));
}

export interface HostSocketSteeringOptions {
  readonly clock: Clock;
  readonly timeoutMs?: number;
  /**
   * Liveness by PID and start time, and the one-process signal (DIPO-93): with both, a stop
   * sequence for a follow-only host becomes one SIGTERM to the verified host PID. Without them a
   * follow-only host is refused as before.
   */
  readonly probe?: ProcessProbe;
  readonly signal?: SignalProcess;
}

/**
 * Stops a follow-only host by signal (DIPO-93; ADR 0006 decision 8 and 0008 section 6
 * amendment): its socket does not answer, so the stop message and the stdin close cannot reach
 * it. After `verifyHostForSignal` passes, the host PID alone gets one SIGTERM; the host then
 * closes its worker's stdin, sends it SIGTERM and SIGKILL 20 s later, and writes `exit.json` as
 * always. Any doubt refuses, and nothing is signalled.
 */
async function stopFollowed(
  host: WorkerHostRow,
  probe: ProcessProbe,
  signal: SignalProcess,
): Promise<SteerResult> {
  const check = await verifyHostForSignal(host, probe);
  if (!check.ok) {
    return {
      ok: false,
      reason: `${followOnlyReason(host.pid)}; dipo sent no signal, because ${check.reason}`,
    };
  }
  if (!signal(host.pid, "SIGTERM")) {
    return {
      ok: false,
      reason: `${followOnlyReason(host.pid)}; SIGTERM to the verified host was refused or it had just exited`,
    };
  }
  return { ok: true, via: "signal" };
}

type SteerResult = Awaited<ReturnType<RunSteering["send"]>>;

/**
 * Sends host ops to a run's worker host over its socket (DIPO-44's protocol), to the newest host of
 * the run: one connection, the ops in order, then closed. A newest host whose row is still pending
 * (written before its spawn, DIPO-93) is waited for up to the timeout, so a stop in that window
 * reaches it.
 */
export function hostSocketSteering(options: HostSocketSteeringOptions): RunSteering {
  const newestHost = async (office: OfficeHandle, runId: string) => {
    const deadline = options.clock.now() + (options.timeoutMs ?? STEER_TIMEOUT_MS);
    for (;;) {
      const host = workerHostsOf(office, runId).at(-1);
      if (host === undefined || !host.pending || options.clock.now() >= deadline) return host;
      await new Promise<void>((resolve) => options.clock.setTimeout(resolve, PENDING_POLL_MS));
    }
  };
  return {
    async send(office, runId, ops) {
      const host = await newestHost(office, runId);
      if (host === undefined) return { ok: false, reason: "the run has no worker host" };
      if (host.pending) {
        return { ok: false, reason: "the run's worker host is still being started" };
      }
      // After a restart a host whose socket did not answer is only followed (DIPO-57); a stop
      // reaches it by a verified signal (DIPO-93).
      if (host.mode === "follow") {
        if (isStopSequence(ops) && options.probe !== undefined && options.signal !== undefined) {
          return stopFollowed(host, options.probe, options.signal);
        }
        return { ok: false, reason: followOnlyReason(host.pid) };
      }
      const connected = await connectHost(host.socketPath, {
        runId,
        clock: options.clock,
        timeoutMs: options.timeoutMs ?? STEER_TIMEOUT_MS,
        token: host.engineToken,
      });
      if (!connected.ok) {
        const why = connected.error === undefined ? "" : ` (${connected.error.message})`;
        return {
          ok: false,
          reason: `the worker host socket ${host.socketPath} is ${connected.reason}${why}`,
        };
      }
      const client = connected.client;
      try {
        for (const op of ops) {
          const request = hostRequestOf(op);
          const reply = await client.request(request);
          if (reply === null) {
            return { ok: false, reason: `the worker host did not answer ${request.op}` };
          }
          if (!reply.ok) {
            return {
              ok: false,
              reason: `${request.op}: ${reply.error.code}: ${reply.error.message}`,
              code: reply.error.code,
            };
          }
        }
        return { ok: true };
      } finally {
        client.close();
      }
    },
  };
}
