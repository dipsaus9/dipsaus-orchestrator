// The real `HostStarter` and `RunIngest` the daemon gives the run launcher (DIPO-74). The host is
// started detached through DIPO-44's `startWorkerHost` and recorded in `worker_hosts`; its events
// are ingested through one DIPO-45 `Ingestor` per office: a first pass and the 1 s `stat` poll at
// once, and the host's `advanced` announcements as soon as its socket answers.

import type { Clock, OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { connectHost, type HostRequest } from "../host/client";
import { Ingestor, type IngestHooks, type IngestTarget } from "../ingest/ingestor";
import type { Env } from "../platform/paths";
import type { ProcessProbe, SpawnDetached } from "../platform/process";
import type { PriceBook } from "../pricing/estimate";
import type { HostOp, WorkerEvent } from "../workers/types";
import { type LaunchedHost, startWorkerHost, workerHostsOf } from "../runs/worker-hosts";

import type { RunSteering } from "./control";
import type { HostStarter, RunIngest } from "./launch";
import type { Watchdog } from "./watchdog";

/** How long the engine waits for a new host's socket before it relies on the poll alone. */
export const HOST_CONNECT_TIMEOUT_MS = 5_000;

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
      startWorkerHost(office, options.clock, {
        runId: run.runId,
        agentId: run.agentId,
        officeDir: run.officeDir,
        runtimeDir: options.runtimeDir,
        plan: run.plan,
        dipoCommand: options.dipoCommand,
        env: options.env,
        probe: options.probe,
        ...(options.spawnDetached === undefined ? {} : { spawnDetached: options.spawnDetached }),
      }),
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

  constructor(options: OfficeIngestOptions) {
    this.#options = options;
  }

  #ingestor(office: OfficeHandle): Ingestor {
    let ingestor = this.#ingestors.get(office.officeId);
    if (ingestor === undefined) {
      ingestor = new Ingestor({
        office,
        clock: this.#options.clock,
        pricing: this.#options.pricing(),
        hooks: this.#hooksFor(office),
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

  start(office: OfficeHandle, host: LaunchedHost, target: IngestTarget): void {
    const ingestor = this.#ingestor(office);
    if (target.work !== undefined) this.#options.watchdog?.track(office, host.runId as RunId);
    ingestor.track(target);
    void connectHost(host.socketPath, {
      runId: host.runId,
      clock: this.#options.clock,
      timeoutMs: HOST_CONNECT_TIMEOUT_MS,
      // The engine's watch: only it may answer hook calls and count as the daemon being up.
      token: host.engineToken ?? null,
    })
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

/** How long a steering op waits for the host's socket and reply. */
export const STEER_TIMEOUT_MS = 5_000;

/**
 * Sends host ops to a run's worker host over its socket (DIPO-44's protocol), to the newest host of
 * the run: one connection, the ops in order, then closed.
 */
export function hostSocketSteering(options: {
  readonly clock: Clock;
  readonly timeoutMs?: number;
}): RunSteering {
  return {
    async send(office, runId, ops) {
      const host = workerHostsOf(office, runId).at(-1);
      if (host === undefined) return { ok: false, reason: "the run has no worker host" };
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
