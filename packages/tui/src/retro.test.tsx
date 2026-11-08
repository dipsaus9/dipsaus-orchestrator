// The retro view (DIPO-453): `6` opens it from home, it shows the lines the engine built from its
// numbers, per tier and type, and Esc goes back. The TUI counts nothing itself.

import { afterEach, describe, expect, it } from "bun:test";

import { mount } from "../test/support/setup";

const mounted: { unmount(): Promise<void> }[] = [];

afterEach(async () => {
  for (const ui of mounted.splice(0)) await ui.unmount();
});

const LINES = [
  "Tier M, type feature: 5 stories, 4 merged",
  "  parks: verify-failing 2, conflict 1",
  "  fix rounds: review 1 failed of 3, CI 1, conflict hand-offs 0; loops 4",
  "  cost: $12.30; Ready to merged: 5.1 h on average over 4",
  "Tier S, type bug: 2 stories, 1 merged",
  "  parks: none",
  "  fix rounds: review 0 failed of 1, CI 0, conflict hand-offs 0; loops 0",
  "  cost: not reported; Ready to merged: no data",
  "Where stories came from: planned 5, worker proposal 2, reviewer advisory 1, quick idea 0, session aside 0, unknown 12",
  "Rework: 2 of 9 merged stories (22%) changed mostly files another story changed in the 14 days before",
  "Ideas the audit rejected: 3",
  "  2 x it is the same as an idea held already (code)",
  "Proposed stories you dismissed: 2",
];

async function open() {
  const view = await mount({ columns: 140, rows: 40 });
  mounted.push(view.ui);
  await view.ui.waitFor("dipsaus-orchestrator");
  return view;
}

describe("the retro view", () => {
  it("renders the numbers per tier and type, where stories came from, rework and rejections", async () => {
    const { ui, session } = await open();
    session.retro = { office: "x", lines: LINES };
    await ui.press("4");
    const frame = await ui.waitFor("Tier M, type feature: 5 stories, 4 merged");
    for (const line of LINES) expect(frame).toContain(line);
    expect(frame).toContain("[Esc] back");
    expect(session.reads.some((read) => read.name === "office.retro")).toBe(true);
  });

  it("shows the engine's error when the numbers cannot be read, and Esc goes home", async () => {
    const { ui } = await open();
    await ui.press("4");
    await ui.waitFor("capability.missing: none");
    await ui.press("escape");
    await ui.waitFor("[o] offices");
  });
});
