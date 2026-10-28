// Conflicts with the base before In Review and the conflict hand-off of a box run (DIPO-149, with
// DIPO-291's marker check; 0002): the hand-off state as data. The flows on a migrated state
// database and real git are in conflicts.ci.test.ts (CI only, DIPO-225).

import { describe, expect, it } from "bun:test";

import { handOffStateOf } from "../../src/run/conflicts";

describe("the hand-off state, as data", () => {
  it("opens a hand-off at its start and counts the failed ones", () => {
    expect(handOffStateOf([])).toEqual({ current: 0, open: false, failed: 0 });
    expect(handOffStateOf(["start 1 abc"])).toEqual({ current: 1, open: true, failed: 0 });
    expect(handOffStateOf(["start 1 abc", "failed 1 blocked", "start 2 abc"])).toEqual({
      current: 2,
      open: true,
      failed: 1,
    });
    expect(handOffStateOf(["start 1 abc", "resolved 1", "failed 1 blocked"])).toEqual({
      current: 1,
      open: false,
      failed: 0,
    });
  });

  it("reads the steps an older dipo wrote, the feedback turn of markers left included", () => {
    expect(
      handOffStateOf(["start 1 abc", "feedback 1", "failed 1 markers", "start 2 abc"]),
    ).toEqual({ current: 2, open: true, failed: 1 });
  });
});
