// The dependencies `serve()` gives `StoryPlanning` (DIPO-227): the builder takes the probe the daemon
// checks worker hosts with, and the planning must carry that same probe, not a second one.

import { describe, expect, it } from "bun:test";

import type { ProcessProbe } from "@dipsaus-orchestrator/engine";

import { storyPlanningDeps } from "../../src/foreground";

const probe: ProcessProbe = async () => null;

describe("storyPlanningDeps (DIPO-227)", () => {
  it("carries the probe it was given and the office parts unchanged", () => {
    const parts = {
      lane: () => undefined,
      git: () => undefined,
      host: { closePr: async () => undefined },
      implemented: () => true,
    };

    const deps = storyPlanningDeps(parts as never, probe);

    expect(deps.probe).toBe(probe);
    expect(deps.lane).toBe(parts.lane);
    expect(deps.git).toBe(parts.git);
    expect(deps.host).toBe(parts.host);
    expect(deps.implemented).toBe(parts.implemented);
  });
});
