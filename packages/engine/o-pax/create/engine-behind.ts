// The engine commits each loaded office's base has after the build commit (DIPO-198), kept in
// memory so `daemon.status` never waits on git. Counting takes a few git steps on the office's
// serial queue, which may be busy with a fetch for up to a minute, while a client gives
// `daemon.status` about a second. So the counts are read off the request path: when the daemon
// has settled, for an office the first time status sees it loaded, and again every
// `ENGINE_BEHIND_REFRESH_MS`. At most one read per office is in flight, so a busy queue never
// collects reads; each git step of a read has its own timeout (`ENGINE_READ_TIMEOUT_MS`).

import { basename } from "node:path";

import type { Clock, OfficeId, TimerHandle } from "@dipsaus-orchestrator/contract";
import type { EngineCommitsRead } from "../git/build-commit";
import type { Logger } from "../log/logger";

import type { EngineBehind } from "./control";

/** How often the counts are read again. A fetch has no hook of its own, so this bounds staleness. */
export const ENGINE_BEHIND_REFRESH_MS = 60_000;

/** One office's count source: its main checkout, for the name, and one read of the count. */
export interface EngineBehindSource {
  readonly mainWorktree: string;
  read(): Promise<EngineCommitsRead>;
}

export interface EngineBehindCacheDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly loadedOffices: () => readonly OfficeId[];
  /** The office's source, or undefined when it has no git loaded. */
  readonly source: (office: OfficeId) => EngineBehindSource | undefined;
  readonly refreshMs?: number;
}

/** What the last read of one office found: its count, or null when nothing can be said. */
export interface KnownCount {
  readonly mainWorktree: string;
  readonly commits: number | null;
}

/** The `daemon.status` rows of `offices` in order: those with a count; the name is the basename. */
export function engineBehindRows(
  offices: readonly OfficeId[],
  known: (office: OfficeId) => KnownCount | undefined,
): EngineBehind[] {
  const rows: EngineBehind[] = [];
  for (const office of offices) {
    const entry = known(office);
    if (entry === undefined || entry.commits === null) continue;
    rows.push({ office, name: basename(entry.mainWorktree), commits: entry.commits });
  }
  return rows;
}

export class EngineBehindCache {
  readonly #deps: EngineBehindCacheDeps;
  readonly #known = new Map<OfficeId, KnownCount>();
  readonly #inFlight = new Map<OfficeId, Promise<void>>();
  #timer: TimerHandle | null = null;
  #stopped = false;

  constructor(deps: EngineBehindCacheDeps) {
    this.#deps = deps;
  }

  /**
   * The cached rows of the loaded offices, without waiting for anything. A loaded office never
   * read yet gets a read started and no row until it finishes.
   */
  rows(): EngineBehind[] {
    const offices = this.#deps.loadedOffices();
    for (const office of offices) {
      if (!this.#known.has(office)) void this.refresh(office);
    }
    return engineBehindRows(offices, (office) => this.#known.get(office));
  }

  /** Reads every loaded office again and forgets offices no longer loaded. */
  refreshAll(): Promise<void> {
    const offices = this.#deps.loadedOffices();
    for (const office of this.#known.keys()) {
      if (!offices.includes(office)) this.#known.delete(office);
    }
    return Promise.all(offices.map((office) => this.refresh(office))).then(() => undefined);
  }

  /** Reads `office` once; while a read of it is in flight, returns that read instead. */
  refresh(office: OfficeId): Promise<void> {
    const running = this.#inFlight.get(office);
    if (running !== undefined) return running;
    if (this.#stopped) return Promise.resolve();
    // Never rejects: reads run unawaited, and an unhandled rejection would drain the daemon.
    const read = this.#read(office)
      .catch((error: unknown) => {
        this.#deps.logger.debug("engine commits after the build commit not read; skipped", {
          office,
          error,
        });
      })
      .finally(() => this.#inFlight.delete(office));
    this.#inFlight.set(office, read);
    return read;
  }

  /** True while a read of `office` is in flight. */
  reading(office: OfficeId): boolean {
    return this.#inFlight.has(office);
  }

  /** Reads every loaded office now, then again every `refreshMs`, until `stop`. */
  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    void this.refreshAll();
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) this.#deps.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    this.#timer = this.#deps.clock.setTimeout(() => {
      this.#timer = null;
      if (this.#stopped) return;
      void this.refreshAll();
      this.#schedule();
    }, this.#deps.refreshMs ?? ENGINE_BEHIND_REFRESH_MS);
  }

  async #read(office: OfficeId): Promise<void> {
    const source = this.#deps.source(office);
    if (source === undefined) {
      this.#known.delete(office);
      return;
    }
    let result: EngineCommitsRead;
    try {
      result = await source.read();
    } catch (error) {
      result = { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    if (this.#stopped) return;
    switch (result.kind) {
      case "count":
        this.#known.set(office, { mainWorktree: source.mainWorktree, commits: result.commits });
        return;
      case "none":
        this.#known.set(office, { mainWorktree: source.mainWorktree, commits: null });
        return;
      case "failed":
        // The repository holds the build commit, but git failed: skip, keep the last count.
        this.#deps.logger.debug("engine commits after the build commit not read; skipped", {
          office,
          detail: result.detail,
        });
        if (!this.#known.has(office)) {
          this.#known.set(office, { mainWorktree: source.mainWorktree, commits: null });
        }
        return;
    }
  }
}
