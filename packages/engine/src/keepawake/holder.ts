// One keep-awake process at a time (0006 decision 12). `acquire` starts it and waits a short
// settle time: a process still running then holds the assertion, one that exited was refused. On
// Linux a refused `block` lock (polkit, typically over SSH or for a lingering session) is retried
// once with `--mode=delay`, which only delays sleep briefly, so the status says the assertion is
// not held and why. A missing `systemd-inhibit` (a non-systemd distribution) or `caffeinate` gives
// the same status.

import type { Clock } from "@dipsaus-orchestrator/contract";

import type { Logger } from "../log/logger";
import {
  type InhibitMode,
  keepAwakeCommand,
  KeepAwakeMissingError,
  type KeepAwakeProcess,
  type SpawnKeepAwake,
} from "../platform/keepawake";
import type { DipoPlatform } from "../platform/paths";

/** `daemon.status.keepAwake` (0005, 0006 decision 5). */
export interface KeepAwakeStatus {
  readonly held: boolean;
  readonly reason?: string;
}

/** A process still running after this long holds its lock; one that exited sooner was refused. */
export const KEEP_AWAKE_SETTLE_MS = 1000;

export interface KeepAwakeHolderDeps {
  readonly platform: DipoPlatform;
  readonly daemonPid: number;
  readonly dipoCommand: readonly [string, ...string[]];
  /** The keep-awake process's environment, Bun flag variables already removed. */
  readonly env: Readonly<Record<string, string>>;
  readonly spawn: SpawnKeepAwake;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly settleMs?: number;
}

type Attempt =
  | { readonly kind: "held"; readonly process: KeepAwakeProcess }
  | { readonly kind: "refused"; readonly reason: string };

function describeExit(exit: { code: number | null; signal: string | null; stderr: string }) {
  const text = exit.stderr.trim().split("\n").at(-1)?.trim() ?? "";
  if (text !== "") return text;
  return exit.signal === null ? `exited with code ${exit.code}` : `ended by ${exit.signal}`;
}

export class KeepAwakeHolder {
  readonly #deps: KeepAwakeHolderDeps;
  #process: KeepAwakeProcess | null = null;
  /** The status of the last attempt while no process holds the full lock. */
  #status: KeepAwakeStatus = { held: false };
  #fullLock = false;

  constructor(deps: KeepAwakeHolderDeps) {
    this.#deps = deps;
  }

  /** True while a keep-awake process runs, a full lock or a delay lock. */
  get running(): boolean {
    return this.#process !== null;
  }

  /** Held only for a running `caffeinate` or a `block` lock. */
  status(): KeepAwakeStatus {
    if (this.#process !== null && this.#fullLock) return { held: true };
    return this.#status;
  }

  /** Starts the keep-awake process unless one runs; resolves with the resulting status. */
  async acquire(why: string): Promise<KeepAwakeStatus> {
    if (this.#process !== null) return this.status();
    const { logger, platform } = this.#deps;
    const block = await this.#attempt(why, "block");
    if (block.kind === "held") {
      this.#adopt(block.process, true);
      logger.info("keep-awake held", { pid: block.process.pid, why });
      return this.status();
    }
    if (platform === "linux" && !block.reason.endsWith("not found")) {
      const delay = await this.#attempt(why, "delay");
      if (delay.kind === "held") {
        this.#adopt(delay.process, false);
        this.#status = {
          held: false,
          reason: `block lock refused (${block.reason}); a delay lock only delays sleep briefly`,
        };
        logger.warn("keep-awake not held: systemd-inhibit refused a block lock", {
          reason: block.reason,
          delayPid: delay.process.pid,
        });
        return this.status();
      }
      this.#status = { held: false, reason: `${block.reason}; delay lock: ${delay.reason}` };
    } else {
      this.#status = { held: false, reason: block.reason };
    }
    logger.warn("keep-awake not held", { reason: this.#status.reason });
    return this.status();
  }

  /** Ends the keep-awake process; the assertion goes with it. */
  release(): void {
    const process = this.#process;
    this.#process = null;
    this.#fullLock = false;
    this.#status = { held: false };
    if (process === null) return;
    process.kill();
    this.#deps.logger.info("keep-awake released", { pid: process.pid });
  }

  #adopt(process: KeepAwakeProcess, fullLock: boolean): void {
    this.#process = process;
    this.#fullLock = fullLock;
    void process.exited.then((exit) => {
      if (this.#process !== process) return;
      // It ended on its own (killed by hand, for example): the next poll starts a new one.
      this.#process = null;
      this.#fullLock = false;
      this.#status = { held: false, reason: `the keep-awake process ${describeExit(exit)}` };
      this.#deps.logger.warn("keep-awake process ended", { pid: process.pid, ...exit });
    });
  }

  async #attempt(why: string, mode: InhibitMode): Promise<Attempt> {
    const { clock, spawn } = this.#deps;
    const cmd = keepAwakeCommand({
      platform: this.#deps.platform,
      daemonPid: this.#deps.daemonPid,
      dipoCommand: this.#deps.dipoCommand,
      why,
      mode,
    });
    let process: KeepAwakeProcess;
    try {
      process = spawn(cmd, this.#deps.env);
    } catch (error) {
      if (error instanceof KeepAwakeMissingError) {
        return { kind: "refused", reason: `${error.program} not found` };
      }
      return {
        kind: "refused",
        reason: `cannot start ${cmd[0]}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    let timer: ReturnType<Clock["setTimeout"]> | null = null;
    const settled = new Promise<"running">((resolve) => {
      timer = clock.setTimeout(
        () => resolve("running"),
        this.#deps.settleMs ?? KEEP_AWAKE_SETTLE_MS,
      );
    });
    const outcome = await Promise.race([process.exited, settled]);
    if (timer !== null) clock.clearTimeout(timer);
    if (outcome === "running") return { kind: "held", process };
    return { kind: "refused", reason: describeExit(outcome) };
  }
}
