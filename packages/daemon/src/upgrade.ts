// Upgrades while the daemon runs (0006 decision 14). Every 60 s the daemon compares a stamp of its
// executable with the one taken at start. A different stamp means the binary was replaced:
// `daemon.status` reports `upgradePending`. With `daemon.autoRestartOnUpgrade: true` the daemon
// drains and starts the new binary once no engine step is running (`busy` is false); otherwise the
// maintainer runs `dipo daemon restart` when it suits (0006 open question 6).

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";
import type { Logger } from "@dipsaus-orchestrator/engine";
import {
  type ExecutableStamp,
  type ReadExecutableStamp,
  sameStamp,
} from "@dipsaus-orchestrator/engine/platform";

/** How often the daemon checks its executable (0006 decision 14). */
export const UPGRADE_CHECK_MS = 60_000;

/** The reason `daemon.state` carries when an upgrade starts the drain. */
export const UPGRADE_REASON = "upgrade";

export interface UpgradeWatcherOptions {
  readonly clock: Clock;
  readonly logger: Pick<Logger, "info" | "warn">;
  /** The daemon's executable: the compiled binary, or the entry script when run from source. */
  readonly executable: string;
  readonly readStamp: ReadExecutableStamp;
  /** `daemon.autoRestartOnUpgrade` from `<state>/config.yaml`. */
  readonly autoRestart: boolean;
  /** Starts the drain that ends in starting the new binary; called at most once. */
  readonly restart: () => void;
  readonly intervalMs?: number;
}

export class UpgradeWatcher {
  readonly #options: UpgradeWatcherOptions;
  readonly #initial: ExecutableStamp | null;
  #timer: TimerHandle | null = null;
  #pending = false;
  #restarting = false;
  #stopped = false;
  #busy: () => boolean = () => false;

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

  /** True once the watcher asked for the restart. */
  get restarting(): boolean {
    return this.#restarting;
  }

  /**
   * Checks every interval from now on. `busy` is true while an engine step (setup, install, verify,
   * commit) runs; an automatic restart waits for it.
   */
  start(busy: () => boolean): void {
    this.#busy = busy;
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
    if (this.#initial === null || this.#restarting) return;
    if (!this.#pending) {
      // A file being replaced may be missing for a moment; the next check sees the new one.
      const now = readStamp(executable);
      if (now === null || sameStamp(now, this.#initial)) return;
      this.#pending = true;
      logger.info("upgrade pending: the daemon's executable changed on disk", {
        executable,
        autoRestart: this.#options.autoRestart,
      });
    }
    if (!this.#options.autoRestart) return;
    if (this.#busy()) {
      logger.info("upgrade waits for the running engine steps to finish");
      return;
    }
    this.#restarting = true;
    logger.info("restarting on the new binary", { executable });
    this.#options.restart();
  }

  #arm(): void {
    this.#timer = this.#options.clock.setTimeout(() => {
      this.#timer = null;
      if (this.#stopped) return;
      this.check();
      if (!this.#restarting && !this.#stopped) this.#arm();
    }, this.#options.intervalMs ?? UPGRADE_CHECK_MS);
  }
}
