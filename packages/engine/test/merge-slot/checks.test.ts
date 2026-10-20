// The required checks a PR waits for in the merge slot (DIPO-73; 0016 rule 2): `ci-ok` and
// `pr-title` must pass, any failed or cancelled required check fails, and a check the host has not
// reported yet is pending.

import { describe, expect, it } from "bun:test";

import {
  checksFinal,
  evaluateChecks,
  REQUIRED_CHECKS,
  requiredCheckStates,
} from "../../src/merge-slot";
import type { CheckBucket } from "../../src/platform/host";

const check = (name: string, bucket: CheckBucket) => ({ name, state: bucket, bucket });

describe("evaluateChecks", () => {
  it("waits for ci-ok and pr-title", () => {
    expect(REQUIRED_CHECKS).toEqual(["ci-ok", "pr-title"]);
    expect(evaluateChecks([])).toEqual({ state: "pending", waiting: ["ci-ok", "pr-title"] });
    expect(evaluateChecks([check("ci-ok", "pass"), check("pr-title", "pending")])).toEqual({
      state: "pending",
      waiting: ["pr-title"],
    });
  });

  it("passes when both pass and no other required check is pending", () => {
    expect(evaluateChecks([check("ci-ok", "pass"), check("pr-title", "pass")])).toEqual({
      state: "passed",
    });
    expect(
      evaluateChecks([check("ci-ok", "pass"), check("pr-title", "pass"), check("lint", "pending")]),
    ).toEqual({ state: "pending", waiting: ["lint"] });
  });

  it("fails on any failed or cancelled required check", () => {
    expect(
      evaluateChecks([check("ci-ok", "fail"), check("pr-title", "pass"), check("x", "cancel")]),
    ).toEqual({ state: "failed", failed: ["ci-ok", "x"] });
  });
});

describe("the required set (DIPO-147)", () => {
  it("joins the office's names with the checks the host marks required", () => {
    const names = ["build"];
    const reported = [check("build", "pass"), check("lint", "pending")];
    expect(requiredCheckStates(reported, names)).toEqual([
      { name: "build", state: "pass" },
      { name: "lint", state: "pending" },
    ]);
    expect(evaluateChecks(reported, names)).toEqual({ state: "pending", waiting: ["lint"] });
    expect(evaluateChecks([check("build", "pass"), check("lint", "pass")], names)).toEqual({
      state: "passed",
    });
  });

  it("counts a check the host has not reported as pending", () => {
    expect(requiredCheckStates([check("ci-ok", "pass")])).toEqual([
      { name: "ci-ok", state: "pass" },
      { name: "pr-title", state: "pending" },
    ]);
    expect(checksFinal([check("ci-ok", "pass")])).toBe(false);
  });

  it("is final when all passed, or when one failed and none is pending", () => {
    expect(checksFinal([check("ci-ok", "pass"), check("pr-title", "pass")])).toBe(true);
    expect(checksFinal([check("ci-ok", "fail"), check("pr-title", "pass")])).toBe(true);
    expect(checksFinal([check("ci-ok", "fail"), check("pr-title", "pending")])).toBe(false);
    expect(checksFinal([check("ci-ok", "fail")])).toBe(false);
  });
});
