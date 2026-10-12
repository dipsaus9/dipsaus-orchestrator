// Recovery steps (0006 decision 7, 0007 section 1). In `recovering` the daemon runs the steps other
// modules registered, in registration order, with the database migrations always first; then it
// enters `running`, or `safe` when the crash counter says so. Reconcile (DIPO-56) and re-attach
// (DIPO-57) plug in here. A drain that starts during recovery lets the current step finish and runs
// no further step.

import type { Clock } from "@dipsaus-orchestrator/contract";
import type { ChildProcesses, Logger, StateDatabase } from "@dipsaus-orchestrator/engine";

import { CRASH_LOOP_REASON, type DaemonLifecycle } from "./lifecycle";

export interface RecoveryContext {
  readonly logger: Logger;
  readonly clock: Clock;
  /** Child processes a step starts go through here, so the drain waits for them. */
  readonly children: ChildProcesses;
  /** The migrated state database; throws when called before the migrations step has run. */
  database(): StateDatabase;
}

export interface RecoveryStep {
  readonly name: string;
  run(context: RecoveryContext): Promise<void>;
}

export const MIGRATIONS_STEP = "migrations";

/** The ordered recovery steps; the migrations step is always the first. */
export class RecoverySteps {
  readonly #steps: RecoveryStep[];

  constructor(migrations: RecoveryStep) {
    this.#steps = [migrations];
  }

  /** Adds a step after every step registered before it. */
  register(step: RecoveryStep): void {
    if (this.#steps.some((s) => s.name === step.name)) {
      throw new Error(`A recovery step named ${JSON.stringify(step.name)} is already registered.`);
    }
    this.#steps.push(step);
  }

  list(): readonly RecoveryStep[] {
    return [...this.#steps];
  }
}

export interface RunRecoveryOptions {
  readonly lifecycle: DaemonLifecycle;
  readonly steps: RecoverySteps;
  readonly context: RecoveryContext;
  /** True when the crash counter requires `safe` (0006 decision 7). */
  readonly crashLoop: boolean;
}

/**
 * Moves `starting` to `recovering`, runs every step, then enters `running` or `safe`. Resolves to
 * false when a drain began before recovery finished; a failing step rejects.
 */
export async function runRecovery(options: RunRecoveryOptions): Promise<boolean> {
  const { lifecycle, steps, context, crashLoop } = options;
  // Read through a function: a drain may change the state while a step runs.
  const recovering = () => lifecycle.state === "recovering";
  if (lifecycle.state !== "starting") return false;
  lifecycle.transition("recovering", "running recovery steps");
  for (const step of steps.list()) {
    if (!recovering()) return false;
    const end = lifecycle.beginWork();
    if (end === null) return false;
    context.logger.info("recovery step", { step: step.name });
    try {
      await step.run(context);
    } catch (error) {
      context.logger.error("recovery step failed", { step: step.name, error });
      throw error;
    } finally {
      end();
    }
  }
  if (!recovering()) return false;
  if (crashLoop) lifecycle.transition("safe", CRASH_LOOP_REASON);
  else lifecycle.transition("running", "recovered");
  return true;
}
