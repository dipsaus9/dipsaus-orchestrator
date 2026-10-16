// When the daemon keeps the machine awake (0006 decision 12): while any office has a run with a
// live worker host, a running verify, or a confirmed batch waiting to start. One assertion covers
// every office. It is taken when work becomes active and released 2 minutes after the last work
// ends, so a run that follows another within that window keeps the same assertion.
//
// The activity is read every `pollMs` and on `poll()`, which code that starts or ends work may call
// to react at once. All time comes from the injected clock.

import type { Clock, TimerHandle } from "@dipsaus-orchestrator/contract";

import type { Logger } from "../log/logger";
import { background } from "../platform/background";
import type { DipoPlatform } from "../platform/paths";
import type { KeepAwakeHolder, KeepAwakeStatus } from "./holder";

/** Active work across all offices. */
export interface WorkActivity {
  /** Runs with a live worker host. */
  readonly runs: number;
  /** Verify steps running. */
  readonly verifies: number;
  /** Confirmed `work.run` batches that claimed a story whose worker has not started. */
  readonly waiting: number;
}

export const NO_WORK: WorkActivity = { runs: 0, verifies: 0, waiting: 0 };

/** The assertion is released this long after the last work ends. */
export const KEEP_AWAKE_RELEASE_MS = 2 * 60_000;
/** How often the activity is read. */
export const KEEP_AWAKE_POLL_MS = 15_000;

export function workCount(activity: WorkActivity): number {
  return activity.runs + activity.verifies + activity.waiting;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The reason text, for example "2 runs active, 1 verify running". */
export function describeWork(activity: WorkActivity): string {
  const parts: string[] = [];
  if (activity.runs > 0) parts.push(`${plural(activity.runs, "run", "runs")} active`);
  if (activity.verifies > 0) {
    parts.push(`${plural(activity.verifies, "verify", "verifies")} running`);
  }
  if (activity.waiting > 0) {
    parts.push(`${plural(activity.waiting, "claimed story", "claimed stories")} waiting to start`);
  }
  return parts.length === 0 ? "no active work" : parts.join(", ");
}

/** What macOS `-i` does not cover; `status` says so (0006 decision 12). */
export const DARWIN_LID_NOTE = "closing the lid on battery still sleeps the Mac";

export interface KeepAwakeDeps {
  readonly platform: DipoPlatform;
  readonly holder: KeepAwakeHolder;
  /** Reads the current activity across all offices. */
  readonly read: () => Promise<WorkActivity>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly releaseAfterMs?: number;
  readonly pollMs?: number;
}

export class KeepAwake {
  readonly #deps: KeepAwakeDeps;
  #activity: WorkActivity = NO_WORK;
  #releaseTimer: TimerHandle | null = null;
  #pollTimer: TimerHandle | null = null;
  /** Set when an acquire in this active period was refused; cleared at release. */
  #refused = false;
  #queue: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(deps: KeepAwakeDeps) {
    this.#deps = deps;
  }

  /** Reads the activity now and every `pollMs` after. */
  start(): void {
    const tick = () => {
      this.#pollTimer = null;
      // A failed poll is logged and the next one still comes (DIPO-110).
      background(() => this.poll(), {
        failed: "keep-awake poll failed",
        log: (message, fields) => this.#deps.logger.warn(message, fields),
        settled: () => {
          if (!this.#stopped) {
            this.#pollTimer = this.#deps.clock.setTimeout(
              tick,
              this.#deps.pollMs ?? KEEP_AWAKE_POLL_MS,
            );
          }
        },
      });
    };
    tick();
  }

  /** Reads the activity once and acts on it; calls run one after another. */
  poll(): Promise<void> {
    const next = this.#queue.then(async () => {
      if (this.#stopped) return;
      let activity: WorkActivity;
      try {
        activity = await this.#deps.read();
      } catch (error) {
        this.#deps.logger.warn("could not read the active work; keep-awake unchanged", { error });
        return;
      }
      await this.update(activity);
    });
    this.#queue = next.catch(() => {});
    return next;
  }

  /** Acts on `activity`: holds while there is work, releases 2 minutes after it ends. */
  async update(activity: WorkActivity): Promise<void> {
    if (this.#stopped) return;
    this.#activity = activity;
    const { holder, clock } = this.#deps;
    if (workCount(activity) > 0) {
      if (this.#releaseTimer !== null) {
        clock.clearTimeout(this.#releaseTimer);
        this.#releaseTimer = null;
      }
      if (!holder.running && !this.#refused) {
        const status = await holder.acquire(describeWork(activity));
        this.#refused = !status.held && !holder.running;
      }
      return;
    }
    if (this.#releaseTimer === null && (holder.running || this.#refused)) {
      this.#releaseTimer = clock.setTimeout(() => {
        this.#releaseTimer = null;
        this.#refused = false;
        holder.release();
      }, this.#deps.releaseAfterMs ?? KEEP_AWAKE_RELEASE_MS);
    }
  }

  /** `daemon.status.keepAwake`. */
  status(): KeepAwakeStatus {
    const status = this.#deps.holder.status();
    if (!status.held) return status;
    const work =
      workCount(this.#activity) > 0
        ? describeWork(this.#activity)
        : "work ended, releasing within 2 minutes";
    return {
      held: true,
      reason: this.#deps.platform === "darwin" ? `${work}; ${DARWIN_LID_NOTE}` : work,
    };
  }

  /** Stops polling and releases the assertion (daemon exit). */
  async stop(): Promise<void> {
    this.#stopped = true;
    const { clock, holder } = this.#deps;
    if (this.#pollTimer !== null) clock.clearTimeout(this.#pollTimer);
    if (this.#releaseTimer !== null) clock.clearTimeout(this.#releaseTimer);
    this.#pollTimer = null;
    this.#releaseTimer = null;
    await this.#queue;
    holder.release();
  }
}
