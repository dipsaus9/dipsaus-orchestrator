// The capture refuses every story scenario before anything runs (DIPO-240, DIPO-347): a developer
// and a reviewer session run only in a box (0008), and a capture in a box is not built yet. No
// `claude` runs.

import { describe, expect, it } from "bun:test";

import { CAPTURE_REFUSED, capture } from "./capture";
import type { Scenario } from "./scenarios";
import { findScenario, SCENARIOS } from "./scenarios";

describe("a story scenario (DIPO-240, DIPO-347)", () => {
  it("is refused before anything runs: a developer session runs only in its box", async () => {
    const scenario = findScenario("success-single") as Scenario;
    const refused = await capture(scenario).catch((error: unknown) => error);
    expect(String(refused)).toContain(CAPTURE_REFUSED);
  });

  it("is refused for a reviewer too: a reviewer session runs only in its own box", async () => {
    const scenario = SCENARIOS.find((candidate) => candidate.kind === "review");
    expect(scenario).toBeDefined();
    const refused = await capture(scenario as Scenario).catch((error: unknown) => error);
    expect(String(refused)).toContain(CAPTURE_REFUSED);
  });
});
