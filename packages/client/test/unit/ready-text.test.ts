// The Queue's ready result names the backlog PR a queued story waits on from the lane's progress,
// not from the command result (DIPO-492).

import { describe, expect, it } from "bun:test";

import type { LaneProgress } from "@dipsaus-orchestrator/contract";

import { readyLines } from "../../src/ready-text";

const result = {
  queued: ["DIPO-1"],
  refused: [{ story: "DIPO-2", messages: ["R01a: no criteria"] }],
};

const lane: LaneProgress = {
  ops: [],
  pr: {
    number: 8,
    url: "https://github.com/o/r/pull/8",
    ci: "running",
    autoMerge: true,
    merged: false,
  },
};

describe("readyLines", () => {
  it("says a queued story waits for its backlog PR before the lane has one", () => {
    expect(readyLines(result, null)).toEqual([
      { story: "DIPO-1", state: "queued", text: "queued: waits for its backlog PR" },
      { story: "DIPO-2", state: "refused", text: "R01a: no criteria" },
    ]);
  });

  it("names the backlog PR the lane reports once it is open", () => {
    expect(readyLines(result, lane)[0]).toEqual({
      story: "DIPO-1",
      state: "queued",
      text: "waiting for the backlog PR #8",
    });
  });
});
