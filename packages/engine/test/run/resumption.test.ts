// The per-reason resume policy table of `resumption.ts` (DIPO-138): the M0 rows resume a
// needs-permission park through its answer and a plan-limit hold through work.resume; every other
// reason has no row, so work.resume answers story.notPausedOrParked for it.

import { describe, expect, it } from "bun:test";

import { KNOWN_PARK_REASONS } from "@dipsaus-orchestrator/contract";

import { PARK_RESUME_POLICY, resumeVia } from "../../src/run";

describe("the resume policy table", () => {
  it("resumes a needs-permission park through the permission answer", () => {
    expect(resumeVia("needs-permission")).toBe("permission-answer");
  });

  it("resumes a plan-limit hold through work.resume", () => {
    expect(resumeVia("plan-limit")).toBe("work.resume");
  });

  it("has the M0 rows only; every other park reason has no row", () => {
    expect(Object.keys(PARK_RESUME_POLICY).toSorted()).toEqual(["needs-permission", "plan-limit"]);
    for (const reason of KNOWN_PARK_REASONS) {
      if (reason === "needs-permission") continue;
      expect(resumeVia(reason)).toBeNull();
    }
    expect(resumeVia("constructor")).toBeNull();
    expect(resumeVia("not-a-reason")).toBeNull();
  });
});
