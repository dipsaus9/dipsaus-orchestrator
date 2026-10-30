// Upgrades while the daemon runs (0005). Every 60 s the daemon compares a stamp of its executable
// with the one taken at start. A different stamp means the binary was replaced: `daemon.status`
// reports `upgradePending`, and the maintainer runs `dipo daemon restart`. The daemon never
// restarts itself.

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";
import type { Logger } from "@dipsaus-orchestrator/engine";
import {
  type ExecutableStamp,
  type ReadExecutableStamp,
  sameStamp,
} from "@dipsaus-orchestrator/engine/platform";

/** How often the daemon checks its executable (0005). */
export const UPGRADE_CHECK_MS = 60_000;

export interface UpgradeWatcherOptions {
  readonly clock: Clock;
  readonly logger: Pick<Logger, "info" | "warn">;
  /** The daemon's executable: the compiled binary, or the entry script when run from source. */
  readonly executable: string;
  readonly readStamp: ReadExecutableStamp;
  readonly intervalMs?: number;
}

export class UpgradeWatcher {
  readonly #options: UpgradeWatcherOptions;
  readonly #initial: ExecutableStamp | null;
  #timer: TimerHandle | null = null;
  #pending = false;
  #stopped = false;

  constructor(options: UpgradeWatcherOptions) {
    this.#options = options;
    this.#initial = options.readStamp(options.executable);
    if (this.#initial === null) {
      options.logger.warn("cannot read the daemon's executable; upgrades are not detected", {
        executable: options.executable,
      });
    }
  }

  /** True once the executable on disk differs from the one this daemon started from. */
  get pending(): boolean {
    return this.#pending;
  }

  /** Checks every interval from now on, until the change is seen or the watcher stops. */
  start(): void {
    if (this.#initial === null || this.#stopped) return;
    this.#arm();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) this.#options.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** One check; the timer calls it every interval. */
  check(): void {
    const { executable, readStamp, logger } = this.#options;
    if (this.#initial === null || this.#pending) return;
    // A file being replaced may be missing for a moment; the next check sees the new one.
    const now = readStamp(executable);
    if (now === null || sameStamp(now, this.#initial)) return;
    this.#pending = true;
    logger.info(
      "upgrade pending: the daemon's executable changed on disk; run `dipo daemon restart`",
      {
        executable,
      },
    );
  }

  #arm(): void {
    this.#timer = this.#options.clock.setTimeout(() => {
      this.#timer = null;
      if (this.#stopped) return;
      this.check();
      if (!this.#pending && !this.#stopped) this.#arm();
    }, this.#options.intervalMs ?? UPGRADE_CHECK_MS);
  }
}
