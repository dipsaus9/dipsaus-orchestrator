// The daemon state machine (DIPO-68, 0006 decision 7): every allowed transition is accepted, every
// other one throws, listeners see `{ from, to, reason }`, and the office-access and scheduling
// predicates report `engine.recovering` and `scheduling.off`, or `database.unavailable` once the
// state database could not be used (DIPO-111).

import { describe, expect, it } from "bun:test";

import { DaemonState } from "@dipsaus-orchestrator/contract";
import { CommandError } from "../../src/commands/errors";

import {
  CRASH_LOOP_REASON,
  DATABASE_UNAVAILABLE,
  DaemonLifecycle,
  TransitionError,
  type StateChange,
} from "../../src/create/lifecycle";

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

describe("an unavailable state database (DIPO-111)", () => {
  const failure = {
    details: { reason: "migration", backup: "/s/backups/pre-v3-20261016T090000.db" },
    text: "Migration 3 failed. No office is loaded. Run `dipo daemon stop`, move /s/dipo.db away or copy /s/backups/pre-v3-20261016T090000.db over it, then start the daemon again.",
  } as const;

  it("holds recovering with the text as reason and refuses office access, not retryable", () => {
    const lifecycle = lifecycleIn("recovering");
    const changes: StateChange[] = [];
    lifecycle.onTransition((change) => changes.push(change));
    expect(lifecycle.holdUnavailable(failure)).toBe(true);
    expect(lifecycle.state).toBe("recovering");
    expect(lifecycle.reason).toBe(failure.text);
    // Not a transition: the state stays recovering.
    expect(changes).toEqual([]);
    const expected = {
      code: DATABASE_UNAVAILABLE,
      message: failure.text,
      retryable: false,
      details: failure.details,
    };
    expect(lifecycle.officeAccess()).toEqual(expected);
    expect(lifecycle.scheduling()).toEqual(expected);
    expect(lifecycle.unavailable).toEqual(expected);
  });

  it("refuses resumeScheduling with database.unavailable instead of daemon.notSafe", () => {
    const lifecycle = lifecycleIn("recovering");
    lifecycle.holdUnavailable(failure);
    let thrown: unknown;
    try {
      lifecycle.resumeScheduling();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CommandError);
    expect((thrown as CommandError).error).toMatchObject({
      code: DATABASE_UNAVAILABLE,
      retryable: false,
    });
    expect(lifecycle.state).toBe("recovering");
  });

  it("still drains, and keeps refusing office access while it does", () => {
    const lifecycle = lifecycleIn("recovering");
    lifecycle.holdUnavailable(failure);
    lifecycle.transition("draining", "daemon.stop");
    expect(lifecycle.officeAccess()?.code).toBe(DATABASE_UNAVAILABLE);
  });

  it("changes nothing outside recovering", () => {
    for (const state of ["starting", "running", "safe", "draining"] as const) {
      const lifecycle = lifecycleIn(state);
      expect(lifecycle.holdUnavailable(failure)).toBe(false);
      expect(lifecycle.unavailable).toBeNull();
    }
  });
});
