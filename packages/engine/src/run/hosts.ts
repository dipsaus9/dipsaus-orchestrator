// The real `HostStarter` and `RunIngest` the daemon gives the run launcher (DIPO-74). The host is
// started detached through DIPO-44's `startWorkerHost` and recorded in `worker_hosts`; its events
// are ingested through one DIPO-45 `Ingestor` per office: a first pass and the 1 s `stat` poll at
// once, and the host's `advanced` announcements as soon as its socket answers.

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import type { OfficeHandle } from "../db/office";
import { connectHost } from "../host/client";
import { Ingestor, type IngestHooks, type IngestTarget } from "../ingest/ingestor";
import type { Env } from "../platform/paths";
import type { ProcessProbe, SpawnDetached } from "../platform/process";
import type { PriceBook } from "../pricing/estimate";
import { type LaunchedHost, startWorkerHost } from "../runs/worker-hosts";

import type { HostStarter, RunIngest } from "./launch";

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
        ...(this.#options.hooks === undefined ? {} : { hooks: this.#options.hooks }),
        ...(this.#options.warn === undefined ? {} : { warn: this.#options.warn }),
      });
      this.#ingestors.set(office.officeId, ingestor);
    }
    return ingestor;
  }

  start(office: OfficeHandle, host: LaunchedHost, target: IngestTarget): void {
    const ingestor = this.#ingestor(office);
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

  /** Stops every ingestor's timers; what they ingested is stored. */
  close(): void {
    for (const ingestor of this.#ingestors.values()) ingestor.close();
    this.#ingestors.clear();
  }
}
