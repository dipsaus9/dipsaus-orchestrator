// The drain (0006 decision 7). `draining` starts no new work, lets pending work finish (command
// writes, the current recovery step), waits for every child process the daemon started itself, and
// is capped at 20 s, or 60 s while workers are being stopped. At the cap the daemon kills the
// process group of every child still running and exits anyway; the next start recovers as after a
// crash. Worker hosts are never the daemon's children here, so they keep running (decision 8).

import type { Clock } from "@dipsaus-orchestrator/contract";
import type { ChildProcesses, Logger } from "@dipsaus-orchestrator/engine";

import type { DaemonLifecycle } from "./lifecycle";

export const DRAIN_CAP_MS = 20_000;
export const DRAIN_CAP_STOP_WORKERS_MS = 60_000;
/** After killing the process groups at the cap, wait this long for the children to be reaped. */
export const KILL_GRACE_MS = 2_000;

export interface DrainRequest {
  readonly reason: string;
  /** `daemon.stop { stopWorkers }`: end the workers first, under the longer cap. */
  readonly stopWorkers: boolean;
}

export interface DrainCaps {
  readonly normalMs: number;
  readonly stopWorkersMs: number;
}

export const DEFAULT_DRAIN_CAPS: DrainCaps = {
  normalMs: DRAIN_CAP_MS,
  stopWorkersMs: DRAIN_CAP_STOP_WORKERS_MS,
};

export interface DrainOptions {
  readonly lifecycle: DaemonLifecycle;
  readonly children: Pick<ChildProcesses, "size" | "waitAll" | "killGroups">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly request: DrainRequest;
  readonly caps?: DrainCaps;
  /** Ends the workers through their hosts; DIPO-50 provides it. */
  readonly stopWorkers?: () => Promise<void>;
}

export interface DrainResult {
  /** True when the cap was reached before the drain finished. */
  readonly capped: boolean;
  /** Children whose process group was killed at the cap. */
  readonly killed: readonly number[];
}

function sleep(clock: Clock, ms: number): { promise: Promise<"cap">; cancel: () => void } {
  let handle: ReturnType<Clock["setTimeout"]> | null = null;
  const promise = new Promise<"cap">((resolve) => {
    handle = clock.setTimeout(() => resolve("cap"), ms);
  });
  return {
    promise,
    cancel: () => {
      if (handle !== null) clock.clearTimeout(handle);
    },
  };
}

/** Enters `draining` (unless already there) and drains within the cap. */
export async function drain(options: DrainOptions): Promise<DrainResult> {
  const { lifecycle, children, clock, logger, request } = options;
  const caps = options.caps ?? DEFAULT_DRAIN_CAPS;
  if (lifecycle.state !== "draining") lifecycle.transition("draining", request.reason);
  const capMs = request.stopWorkers ? caps.stopWorkersMs : caps.normalMs;
  logger.info("draining", {
    reason: request.reason,
    stopWorkers: request.stopWorkers,
    capMs,
    pendingWork: lifecycle.inFlight,
    children: children.size,
  });

  const work = (async () => {
    if (request.stopWorkers) {
      try {
        if (options.stopWorkers === undefined) logger.info("no workers to stop");
        else await options.stopWorkers();
      } catch (error) {
        logger.error("stopping the workers failed", { error });
      }
    }
    await lifecycle.idle();
    await children.waitAll();
  })();
  const cap = sleep(clock, capMs);
  const outcome = await Promise.race([work.then(() => "done" as const), cap.promise]);
  cap.cancel();
  if (outcome === "done") {
    logger.info("drained");
    return { capped: false, killed: [] };
  }

  const killed = children.killGroups("SIGKILL");
  logger.warn("the drain reached its cap; exiting anyway", {
    capMs,
    pendingWork: lifecycle.inFlight,
    killedProcessGroups: killed,
  });
  const grace = sleep(clock, KILL_GRACE_MS);
  await Promise.race([children.waitAll(), grace.promise]);
  grace.cancel();
  return { capped: true, killed };
}
