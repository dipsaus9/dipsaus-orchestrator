// The dependencies `createEngine` gives `StoryPlanning` (DIPO-227): the process probe is the one the
// daemon passes in, so the wiring is checked here and not only by tsc through the required field.

import { describe, expect, it } from "bun:test";

import type { ProcessProbe } from "../../src/platform/process";

import { storyPlanningDeps } from "../../src/create/stories";
import { backlogLayout } from "../story-store/backlog";

const probe: ProcessProbe = async () => null;
const host = { closePr: async () => undefined } as never;
const implemented = () => true;
const lane = () => undefined;

describe("storyPlanningDeps (DIPO-227)", () => {
  it("carries the probe it is given and the parts it is built from", () => {
    const deps = storyPlanningDeps(
      { stories: backlogLayout, lane, git: lane, host, implemented },
      probe,
    );

    expect(deps.probe).toBe(probe);
    expect(deps.lane).toBe(lane);
    expect(deps.host).toBe(host);
    expect(deps.implemented).toBe(implemented);
  });
});
