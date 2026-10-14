// The real `HostStarter` and `RunIngest` the daemon gives the run launcher (DIPO-74). The host is
// started detached through DIPO-44's `startWorkerHost` and recorded in `worker_hosts`; its events
// are ingested through one DIPO-45 `Ingestor` per office: a first pass and the 1 s `stat` poll at
// once, and the host's `advanced` announcements as soon as its socket answers.

import type { Clock, OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { connectHost, type HostClient, type HostRequest } from "../host/client";
import { Ingestor, type IngestHooks, type IngestTarget, type PassResult } from "../ingest/ingestor";
import type { Env } from "../platform/paths";
import type { ProcessProbe, SpawnDetached } from "../platform/process";
import type { PriceBook } from "../pricing/estimate";
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
        hooks: this.#hooksFor(office.officeId),
        ...(this.#options.warn === undefined ? {} : { warn: this.#options.warn }),
      });
      this.#ingestors.set(office.officeId, ingestor);
    }
    return ingestor;
  }

  /** The caller's hooks, with the watchdog and `onAppended` added. */
  #hooksFor(office: OfficeId): IngestHooks {
    const hooks = this.#options.hooks ?? {};
    const { watchdog, onAppended } = this.#options;
    return {
      ...hooks,
      onLines: (run, agent) => {
        watchdog?.lineSeen(run);
        hooks.onLines?.(run, agent);
      },
      onEnded: (run, agent, end) => {
        watchdog?.untrack(run);
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
    void connectHost(host.socketPath, {
      runId: host.runId,
      clock: this.#options.clock,
      timeoutMs: HOST_CONNECT_TIMEOUT_MS,
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

/** Why a follow-only host cannot be steered (0006 decision 8, 0009 section 3). */
export function followOnlyReason(pid: number): string {
  return `the worker host (pid ${pid}) runs in follow-only mode after a daemon restart: its socket did not answer, so dipo follows its output until it exits but cannot steer it`;
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
      // After a restart a host whose socket did not answer is only followed (DIPO-57).
      if (host.mode === "follow") return { ok: false, reason: followOnlyReason(host.pid) };
      const connected = await connectHost(host.socketPath, {
        runId,
        clock: options.clock,
        timeoutMs: options.timeoutMs ?? STEER_TIMEOUT_MS,
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
          const request: HostRequest =
            "write" in op
              ? { op: "write", data: op.write }
              : "closeStdin" in op
                ? { op: "closeStdin" }
                : op.afterMs === undefined
                  ? { op: "signal", signal: op.signal }
                  : { op: "signal", signal: op.signal, afterMs: op.afterMs };
          const reply = await client.request(request);
          if (reply === null) {
            return { ok: false, reason: `the worker host did not answer ${request.op}` };
          }
          if (!reply.ok) {
            return {
              ok: false,
              reason: `${request.op}: ${reply.error.code}: ${reply.error.message}`,
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
