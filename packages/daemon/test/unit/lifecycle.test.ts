// The daemon state machine (DIPO-68, 0006 decision 7): every allowed transition is accepted, every
// other one throws, listeners see `{ from, to, reason }`, and the office-access and scheduling
// predicates report `engine.recovering` and `scheduling.off`.

import { describe, expect, it } from "bun:test";

import { DaemonState } from "@dipsaus-orchestrator/contract";
import { CommandError } from "@dipsaus-orchestrator/engine";

import {
  CRASH_LOOP_REASON,
  DaemonLifecycle,
  TransitionError,
  type StateChange,
} from "../../src/lifecycle";

const STATES = DaemonState.options;

/** The transitions of 0006 decision 7, written out independently of the table under test. */
const ALLOWED = new Set([
  "starting>recovering",
  "recovering>running",
  "recovering>safe",
  "safe>running",
  // SIGTERM always means the graceful drain, from every live state.
  "starting>draining",
  "recovering>draining",
  "running>draining",
  "safe>draining",
]);

/** A shortest path from `starting` to each state. */
const PATH: Record<DaemonState, DaemonState[]> = {
  starting: [],
  recovering: ["recovering"],
  running: ["recovering", "running"],
  safe: ["recovering", "safe"],
  draining: ["draining"],
};

function lifecycleIn(state: DaemonState): DaemonLifecycle {
  const lifecycle = new DaemonLifecycle();
  for (const step of PATH[state]) lifecycle.transition(step, "setup");
  expect(lifecycle.state).toBe(state);
  return lifecycle;
}

describe("DaemonLifecycle transitions", () => {
  it("starts in starting with its reason", () => {
    const lifecycle = new DaemonLifecycle("daemon started");
    expect(lifecycle.state).toBe("starting");
    expect(lifecycle.reason).toBe("daemon started");
  });

  for (const from of STATES) {
    for (const to of STATES) {
      const allowed = ALLOWED.has(`${from}>${to}`);
      it(`${allowed ? "accepts" : "rejects"} ${from} -> ${to}`, () => {
        const lifecycle = lifecycleIn(from);
        const seen: StateChange[] = [];
        lifecycle.onTransition((change) => seen.push(change));
        if (allowed) {
          expect(lifecycle.transition(to, "because")).toEqual({ from, to, reason: "because" });
          expect(lifecycle.state).toBe(to);
          expect(lifecycle.reason).toBe("because");
          expect(seen).toEqual([{ from, to, reason: "because" }]);
        } else {
          expect(() => lifecycle.transition(to, "because")).toThrow(TransitionError);
          expect(lifecycle.state).toBe(from);
          expect(lifecycle.reason).toBe(from === "starting" ? "daemon started" : "setup");
          expect(seen).toEqual([]);
        }
      });
    }
  }

  it("reports to every listener until it is removed", () => {
    const lifecycle = new DaemonLifecycle();
    const first: StateChange[] = [];
    const second: StateChange[] = [];
    const removeFirst = lifecycle.onTransition((change) => first.push(change));
    lifecycle.onTransition((change) => second.push(change));
    lifecycle.transition("recovering", "a");
    removeFirst();
    lifecycle.transition("running", "b");
    expect(first.map((c) => c.to)).toEqual(["recovering"]);
    expect(second.map((c) => c.to)).toEqual(["recovering", "running"]);
  });
});

describe("resumeScheduling", () => {
  it("leaves safe for running", () => {
    const lifecycle = lifecycleIn("recovering");
    lifecycle.transition("safe", CRASH_LOOP_REASON);
    expect(lifecycle.resumeScheduling()).toEqual({
      from: "safe",
      to: "running",
      reason: "scheduling resumed",
    });
  });

  it("throws daemon.notSafe outside safe", () => {
    for (const state of STATES.filter((s) => s !== "safe")) {
      const lifecycle = lifecycleIn(state);
      try {
        lifecycle.resumeScheduling();
        throw new Error("expected a CommandError");
      } catch (error) {
        expect(error).toBeInstanceOf(CommandError);
        expect((error as CommandError).error).toMatchObject({
          code: "daemon.notSafe",
          retryable: false,
        });
      }
      expect(lifecycle.state).toBe(state);
    }
  });
});

describe("predicates", () => {
  it("reports the retryable engine.recovering for office access in starting and recovering", () => {
    for (const state of STATES) {
      const access = lifecycleIn(state).officeAccess();
      if (state === "starting" || state === "recovering") {
        expect(access).toMatchObject({ code: "engine.recovering", retryable: true });
      } else {
        expect(access).toBeNull();
      }
    }
  });

  it("reports the retryable scheduling.off in safe, with the reason", () => {
    const lifecycle = lifecycleIn("recovering");
    lifecycle.transition("safe", CRASH_LOOP_REASON);
    const error = lifecycle.scheduling();
    expect(error).toMatchObject({
      code: "scheduling.off",
      retryable: true,
      details: { state: "safe", reason: "crash loop" },
    });
    expect(lifecycle.officeAccess()).toBeNull();
  });

  it("lets scheduling run only in running", () => {
    const codes = Object.fromEntries(
      STATES.map((state) => [state, lifecycleIn(state).scheduling()?.code ?? null]),
    );
    expect(codes).toEqual({
      starting: "engine.recovering",
      recovering: "engine.recovering",
      running: null,
      draining: "scheduling.off",
      safe: "scheduling.off",
    });
  });
});

describe("work tracking", () => {
  it("starts no new work in draining and resolves idle once work ends", async () => {
    const lifecycle = lifecycleIn("running");
    await lifecycle.idle();
    const end = lifecycle.beginWork();
    expect(end).not.toBeNull();
    expect(lifecycle.inFlight).toBe(1);
    lifecycle.transition("draining", "SIGTERM");
    expect(lifecycle.beginWork()).toBeNull();
    let idle = false;
    const waiting = lifecycle.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    end?.();
    end?.(); // ending twice counts once
    await waiting;
    expect(lifecycle.inFlight).toBe(0);
  });
});
