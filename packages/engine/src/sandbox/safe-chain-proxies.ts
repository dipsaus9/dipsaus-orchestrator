// The Safe-Chain checking proxies of the daemon's runs (DIPO-84), one per run at most. A launch or
// resume starts its run's proxy before the plan (the plan names its port) and stops any earlier
// one of the same run first. A proxy stops when the session's worker ends (`stop`), when no worker
// host started for it within `attachMs` after a successful launch check (a claim rolled back or a
// host that did not start), when its gate exits on its own, and with the daemon (`stopAll`; the
// gate also stops when its stdin closes). After a daemon restart a re-attached worker keeps its
// settings but has no proxy: its installs fail, never unchecked.

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

export interface SafeChainProxyHandle {
  readonly port: number;
  readonly dir: string;
  readonly exited: Promise<void>;
  stop(): Promise<void>;
}

export type SafeChainProxyStarter = (request: {
  readonly runId: string;
  readonly caFile: string;
}) => Promise<
  | { readonly ok: true; readonly proxy: SafeChainProxyHandle }
  | { readonly ok: false; readonly reason: string }
>;

/** How long a checked proxy waits for its worker host before it stops. */
export const PROXY_ATTACH_MS = 120_000;

interface Entry {
  readonly proxy: SafeChainProxyHandle;
  timer: TimerHandle | null;
}

export class SafeChainProxies {
  readonly #clock: Clock;
  readonly #start: SafeChainProxyStarter;
  readonly #attachMs: number;
  readonly #warn: ((message: string, fields: Record<string, unknown>) => void) | undefined;
  readonly #entries = new Map<string, Entry>();

  constructor(deps: {
    readonly clock: Clock;
    readonly start: SafeChainProxyStarter;
    readonly attachMs?: number;
    readonly warn?: (message: string, fields: Record<string, unknown>) => void;
  }) {
    this.#clock = deps.clock;
    this.#start = deps.start;
    this.#attachMs = deps.attachMs ?? PROXY_ATTACH_MS;
    this.#warn = deps.warn;
  }

  /** The run's running proxy, if any. */
  get(runId: string): SafeChainProxyHandle | undefined {
    return this.#entries.get(runId)?.proxy;
  }

  /** Starts the run's proxy, after stopping an earlier one of the same run. */
  async start(runId: string, caFile: string) {
    await this.stop(runId);
    const started = await this.#start({ runId, caFile });
    if (!started.ok) return started;
    const entry: Entry = { proxy: started.proxy, timer: null };
    this.#entries.set(runId, entry);
    void started.proxy.exited.then(() => {
      if (this.#entries.get(runId) !== entry) return;
      this.#forget(runId, entry);
      this.#warn?.("the Safe-Chain proxy of a run stopped; its installs now fail", { run: runId });
    });
    return started;
  }

  /** The launch check passed: the proxy stops unless a worker host starts within `attachMs`. */
  awaitHost(runId: string): void {
    const entry = this.#entries.get(runId);
    if (entry === undefined) return;
    if (entry.timer !== null) this.#clock.clearTimeout(entry.timer);
    entry.timer = this.#clock.setTimeout(() => {
      entry.timer = null;
      void this.stop(runId);
    }, this.#attachMs);
  }

  /** A worker host of the run started: its proxy stays until the session ends. */
  hostStarted(runId: string): void {
    const entry = this.#entries.get(runId);
    if (entry?.timer === null || entry === undefined) return;
    this.#clock.clearTimeout(entry.timer);
    entry.timer = null;
  }

  async stop(runId: string): Promise<void> {
    const entry = this.#entries.get(runId);
    if (entry === undefined) return;
    this.#forget(runId, entry);
    await entry.proxy.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((runId) => this.stop(runId)));
  }

  #forget(runId: string, entry: Entry): void {
    if (entry.timer !== null) this.#clock.clearTimeout(entry.timer);
    entry.timer = null;
    this.#entries.delete(runId);
  }
}
