// Recovery steps (DIPO-68): registration order with the migrations first, `running` or `safe` at
// the end, and a drain during recovery lets the current step finish and runs no further step.

import { describe, expect, it } from "bun:test";

import { ChildProcesses, createLogger, type StateDatabase } from "@dipsaus-orchestrator/engine";
import { ManualClock } from "@dipsaus-orchestrator/testkit";

import { DaemonLifecycle } from "../../src/lifecycle";
import {
  MIGRATIONS_STEP,
  RecoverySteps,
  runRecovery,
  type RecoveryContext,
  type RecoveryStep,
} from "../../src/recovery";

const clock = new ManualClock();

function context(): RecoveryContext {
  return {
    logger: createLogger({ clock, sinks: [], component: "test" }),
    clock,
    children: new ChildProcesses(),
    database: () => ({}) as StateDatabase,
  };
}

function recordingStep(name: string, order: string[]): RecoveryStep {
  return {
    name,
    run: async () => {
      order.push(name);
    },
  };
}

describe("runRecovery", () => {
  it("runs the migrations first, then the steps in registration order, then running", async () => {
    const order: string[] = [];
    const steps = new RecoverySteps(recordingStep(MIGRATIONS_STEP, order));
    steps.register(recordingStep("reconcile", order));
    steps.register(recordingStep("re-attach", order));
    const lifecycle = new DaemonLifecycle();
    const states: string[] = [];
    lifecycle.onTransition((change) => states.push(`${change.to}:${change.reason}`));

    expect(await runRecovery({ lifecycle, steps, context: context(), crashLoop: false })).toBe(
      true,
    );
    expect(order).toEqual([MIGRATIONS_STEP, "reconcile", "re-attach"]);
    expect(states).toEqual(["recovering:running recovery steps", "running:recovered"]);
  });

  it("enters safe with reason crash loop when the crash counter requires it", async () => {
    const steps = new RecoverySteps(recordingStep(MIGRATIONS_STEP, []));
    const lifecycle = new DaemonLifecycle();
    await runRecovery({ lifecycle, steps, context: context(), crashLoop: true });
    expect(lifecycle.state).toBe("safe");
    expect(lifecycle.reason).toBe("crash loop");
  });

  it("keeps office access closed while a step runs", async () => {
    const lifecycle = new DaemonLifecycle();
    const seen: (string | null)[] = [];
    const steps = new RecoverySteps({
      name: MIGRATIONS_STEP,
      run: async () => {
        seen.push(lifecycle.officeAccess()?.code ?? null);
      },
    });
    await runRecovery({ lifecycle, steps, context: context(), crashLoop: false });
    expect(seen).toEqual(["engine.recovering"]);
    expect(lifecycle.officeAccess()).toBeNull();
  });

  it("refuses a second step with the same name", () => {
    const steps = new RecoverySteps(recordingStep(MIGRATIONS_STEP, []));
    expect(() => steps.register(recordingStep(MIGRATIONS_STEP, []))).toThrow("already registered");
  });

  it("lets the running step finish and runs no further step once draining starts", async () => {
    const order: string[] = [];
    const lifecycle = new DaemonLifecycle();
    const gate = Promise.withResolvers<void>();
    const steps = new RecoverySteps({
      name: MIGRATIONS_STEP,
      run: async () => {
        order.push("migrations started");
        await gate.promise;
        order.push("migrations finished");
      },
    });
    steps.register(recordingStep("reconcile", order));
    const running = runRecovery({ lifecycle, steps, context: context(), crashLoop: false });
    await Promise.resolve();
    expect(lifecycle.inFlight).toBe(1);
    lifecycle.transition("draining", "SIGTERM");
    const idle = lifecycle.idle();
    gate.resolve();
    await idle;
    expect(await running).toBe(false);
    expect(order).toEqual(["migrations started", "migrations finished"]);
    expect(lifecycle.state).toBe("draining");
  });

  it("rejects when a step fails and ends its work", async () => {
    const lifecycle = new DaemonLifecycle();
    const steps = new RecoverySteps({
      name: MIGRATIONS_STEP,
      run: async () => {
        throw new Error("migration 3 failed");
      },
    });
    await expect(
      runRecovery({ lifecycle, steps, context: context(), crashLoop: false }),
    ).rejects.toThrow("migration 3 failed");
    await lifecycle.idle();
    expect(lifecycle.state).toBe("recovering");
  });
});
