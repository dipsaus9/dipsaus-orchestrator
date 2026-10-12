// The lifecycle check in front of every command and read (0006 decision 7, DIPO-24 AC #9): office
// commands and reads get `engine.recovering` in `starting` and `recovering`, scheduling commands
// get `scheduling.off` in `safe`, and the handshake, `commands.describe` and `daemon.*` always run.

import { describe, expect, it } from "bun:test";

import type { DaemonState } from "@dipsaus-orchestrator/contract";

import { DaemonLifecycle } from "../../src/lifecycle";
import { lifecycleGate } from "../../src/server";

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
  return lifecycle;
}

const code = (state: DaemonState, kind: "command" | "read", name: string) =>
  lifecycleGate(lifecycleIn(state), kind, name)?.code ?? null;

describe("lifecycleGate", () => {
  for (const state of ["starting", "recovering"] as const) {
    it(`answers office commands and reads with the retryable engine.recovering in ${state}`, () => {
      const error = lifecycleGate(lifecycleIn(state), "command", "work.pause");
      expect(error).toMatchObject({ code: "engine.recovering", retryable: true });
      expect(code(state, "command", "work.run")).toBe("engine.recovering");
      expect(code(state, "read", "office.snapshot")).toBe("engine.recovering");
      expect(code(state, "command", "office.open")).toBe("engine.recovering");
    });
  }

  it("answers scheduling commands with the retryable scheduling.off in safe", () => {
    const error = lifecycleGate(lifecycleIn("safe"), "command", "work.run");
    expect(error).toMatchObject({ code: "scheduling.off", retryable: true });
    expect(code("safe", "command", "work.pause")).toBeNull();
    expect(code("safe", "read", "office.snapshot")).toBeNull();
  });

  it("lets everything run in running", () => {
    expect(code("running", "command", "work.run")).toBeNull();
    expect(code("running", "read", "office.snapshot")).toBeNull();
  });

  it("starts no command in draining but daemon.*, and still answers reads", () => {
    expect(code("draining", "command", "work.pause")).toBe("scheduling.off");
    expect(code("draining", "read", "office.snapshot")).toBeNull();
    expect(code("draining", "command", "daemon.stop")).toBeNull();
  });

  for (const state of ["starting", "recovering", "safe", "draining"] as const) {
    it(`always lets the handshake, commands.describe and daemon.* run in ${state}`, () => {
      expect(code(state, "read", "engine.hello")).toBeNull();
      expect(code(state, "read", "commands.describe")).toBeNull();
      expect(code(state, "read", "daemon.status")).toBeNull();
      expect(code(state, "command", "daemon.stop")).toBeNull();
      expect(code(state, "command", "daemon.resumeScheduling")).toBeNull();
    });
  }
});
