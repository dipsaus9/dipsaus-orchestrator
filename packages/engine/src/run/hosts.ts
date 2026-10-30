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
import { OP_SINCE } from "../host/protocol";
import { Ingestor, type IngestHooks, type IngestTarget, type PassResult } from "../ingest/ingestor";
import type { OutputPrivacy } from "../ingest/output";
import type { Env } from "../platform/paths";
import type { ProcessProbe, SpawnDetached } from "../platform/process";
import type { HostOp, WorkerEvent } from "../workers/types";
import { type LaunchedHost, startWorkerHost, workerHostsOf } from "../runs/worker-hosts";

import type { RunSteering } from "./control";
import type { HostStarter, RunIngest } from "./launch";
import type { Watchdog } from "./watchdog";

/** How long one ask of a host's socket for its handshake takes at most: the PID ask of re-attach. */
export const HOST_CONNECT_TIMEOUT_MS = 5_000;

/**
 * How long a new worker host has to be claimed by a daemon's handshake, counted from its
 * `worker_hosts` row (DIPO-386, 0008). Its launch file carries the deadline; a host no daemon
 * claimed by then stops its worker and refuses a later handshake. Until then the daemon that
 * started it keeps connecting, and a restart asks a pending row's socket again. Longer than
 * `HOST_CONNECT_TIMEOUT_MS`, so a host that binds its socket late is still claimed.
 */
export const HOST_LAUNCH_DEADLINE_MS = 30_000;

/** The launch deadline of a host whose row was written at `startedAt`: one value for both sides. */
export function hostLaunchDeadline(startedAt: number): number {
  return startedAt + HOST_LAUNCH_DEADLINE_MS;
}

/**
 * Claims a host (DIPO-386, 0008): the `claim` op, sent only by a daemon that holds the host's
 * verified PID in its `worker_hosts` row and follows its run, and only when the handshake named
 * that PID. A handshake alone claims nothing, and a host no daemon claimed by its launch deadline
 * stops itself. A host that speaks no `claim` (an earlier binary's, with no launch deadline) needs
 * none. Returns why the host was not claimed, or null.
 */
export async function claimHost(client: HostClient, recordedPid: number): Promise<string | null> {
  if (client.hostPid !== recordedPid) {
    return `its handshake named pid ${client.hostPid}, not the recorded ${recordedPid}`;
  }
  if (client.version < OP_SINCE.claim) return null;
  const reply = await client.request({ op: "claim" });
  if (reply === null) return "it did not answer the claim";
  return reply.ok ? null : `${reply.error.code}: ${reply.error.message}`;
}

/** How long the engine waits between connection attempts while a new host has not bound its socket. */
export const HOST_CONNECT_RETRY_MS = 25;

/** The least time a connection attempt gives the host's hello, also near the deadline. */
export const HOST_HELLO_MIN_MS = 1_000;

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
    start: (office, run) => {
      const startedAt = options.clock.now();
      return startWorkerHost(
        office,
        options.clock,
        {
          runId: run.runId,
          agentId: run.agentId,
          officeDir: run.officeDir,
          runtimeDir: options.runtimeDir,
          plan: run.plan,
          dipoCommand: options.dipoCommand,
          startedAt,
          launchDeadline: hostLaunchDeadline(startedAt),
          env: options.env,
          probe: options.probe,
          ...(options.spawnDetached === undefined ? {} : { spawnDetached: options.spawnDetached }),
        },
        {
          ...(run.processedOffset === undefined ? {} : { processedOffset: run.processedOffset }),
          ...(run.record === undefined ? {} : { record: run.record }),
        },
      );
    },
  };
}

export interface OfficeIngestOptions {
  readonly clock: Clock;
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
   * The live question rule and the web call counts: they hear every committed pass's worker
   * events and every worker exit with the run's office.
   */
  readonly runEvents?: OfficeRunListener;
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
  /** Set by `close`: a connection attempt still under way stops and watches nothing. */
  #closed = false;

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
        hooks: this.#hooksFor(office),
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
    const { watchdog, onAppended, runEvents } = this.#options;
    return {
      ...hooks,
      onLines: (run, agent) => {
        watchdog?.lineSeen(run);
        hooks.onLines?.(run, agent);
      },
      onWorkerEvents: (run, agent, events) => {
        hooks.onWorkerEvents?.(run, agent, events);
        runEvents?.onWorkerEvents(handle, run, agent, events);
      },
      onEnded: (run, agent, end) => {
        watchdog?.untrack(run);
        runEvents?.onEnded(handle, run);
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
        if (connected.ok && this.#closed) {
          connected.client.close();
          return;
        }
        if (connected.ok) {
          // The host is recorded and its run followed: claim it, so it keeps its worker (DIPO-386).
          const unclaimed = await claimHost(connected.client, host.pid);
          if (unclaimed !== null) {
            this.#options.warn?.(
              "the worker host was not claimed; it stops its worker at its launch deadline",
              { run: host.runId, reason: unclaimed },
            );
          }
          await ingestor.watch(host.runId, host.agentId, connected.client);
          return;
        }
        // Without the socket the 1 s poll keeps ingesting, but no engine watches the host, so it
        // answers every waiting hook call with no decision: say so (DIPO-181).
        if (!this.#closed) {
          this.#options.warn?.(
            "the engine does not watch the worker host; waiting hook calls get no decision",
            { run: host.runId, reason: connected.reason },
          );
        }
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
   * detached host was spawned, and the host binds its socket a moment later (DIPO-181). The
   * handshake claims the host, which stops its worker when no daemon claimed it by its launch
   * deadline (DIPO-386), so "unreachable" is retried up to that deadline; a refusal or a silent
   * socket ends it.
   */
  async #connectWhenBound(host: LaunchedHost): Promise<ConnectHostResult> {
    const { clock } = this.#options;
    const deadline = host.launchDeadline;
    for (;;) {
      const left = deadline - clock.now();
      const connected = await connectHost(host.socketPath, {
        runId: host.runId,
        clock,
        // A host that binds late still gets a full second for its hello.
        timeoutMs: Math.max(HOST_HELLO_MIN_MS, left),
      });
      if (connected.ok || connected.reason !== "unreachable" || this.#closed) return connected;
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
    this.#closed = true;
    this.#options.watchdog?.close();
    for (const ingestor of this.#ingestors.values()) ingestor.close();
    this.#ingestors.clear();
  }
}

/** The host socket request that carries one host op. */
export function hostRequestOf(op: HostOp): HostRequest {
  if ("write" in op) return { op: "write", data: op.write };
  if ("closeStdin" in op) return { op: "closeStdin" };
  return op.afterMs === undefined
    ? { op: "signal", signal: op.signal }
    : { op: "signal", signal: op.signal, afterMs: op.afterMs };
}

/** How long a steering op waits for the host's socket and reply. */
export const STEER_TIMEOUT_MS = 5_000;

/** How often steering looks again at a host row that is still pending (DIPO-93). */
export const PENDING_POLL_MS = 50;

export interface HostSocketSteeringOptions {
  readonly clock: Clock;
  readonly timeoutMs?: number;
}

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
