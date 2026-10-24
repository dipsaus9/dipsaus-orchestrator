// Conflicts with the base before In Review and the conflict hand-off of a box run (DIPO-149, with
// DIPO-291's marker check; 0019 sections 6, 8 and 10): the hand-off state as data. The flows on a
// migrated state database and real git are in conflicts.ci.test.ts (CI only, DIPO-225).

import { describe, expect, it } from "bun:test";

import { handOffStateOf } from "../../src/run/conflicts";

describe("the hand-off state, as data", () => {
  it("opens a hand-off at its start, gives it one feedback turn, and counts the failed ones", () => {
    expect(handOffStateOf([])).toEqual({ current: 0, open: false, feedback: false, failed: 0 });
    expect(handOffStateOf(["start 1 abc"])).toEqual({
      current: 1,
      open: true,
      feedback: false,
      failed: 0,
    });
    expect(
      handOffStateOf(["start 1 abc", "feedback 1", "failed 1 markers", "start 2 abc"]),
    ).toEqual({ current: 2, open: true, feedback: false, failed: 1 });
    expect(handOffStateOf(["start 1 abc", "resolved 1", "failed 1 markers"])).toEqual({
      current: 1,
      open: false,
      feedback: false,
      failed: 0,
    });
  });
});
