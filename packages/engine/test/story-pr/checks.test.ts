// The required checks of a story PR's head (0002): the names the base requires on GitHub must
// pass, any failed or cancelled required check fails, and a check the host has not reported yet is
// pending.

import { describe, expect, it } from "bun:test";

import type { CheckBucket } from "../../src/platform/host";
import { checksFinal, evaluateChecks, requiredCheckStates } from "../../src/story-pr/checks";

const check = (name: string, bucket: CheckBucket) => ({ name, state: bucket, bucket });
const BASE = ["ci-ok", "pr-title"];

describe("evaluateChecks", () => {
  it("waits for every check the base requires", () => {
    expect(evaluateChecks([], BASE)).toEqual({ state: "pending", waiting: ["ci-ok", "pr-title"] });
    expect(evaluateChecks([check("ci-ok", "pass"), check("pr-title", "pending")], BASE)).toEqual({
      state: "pending",
      waiting: ["pr-title"],
    });
  });

  it("passes when they pass and no other required check is pending", () => {
    expect(evaluateChecks([check("ci-ok", "pass"), check("pr-title", "pass")], BASE)).toEqual({
      state: "passed",
    });
    expect(
      evaluateChecks(
        [check("ci-ok", "pass"), check("pr-title", "pass"), check("lint", "pending")],
        BASE,
      ),
    ).toEqual({ state: "pending", waiting: ["lint"] });
  });

  it("fails on any failed or cancelled required check", () => {
    expect(
      evaluateChecks(
        [check("ci-ok", "fail"), check("pr-title", "pass"), check("x", "cancel")],
        BASE,
      ),
    ).toEqual({ state: "failed", failed: ["ci-ok", "x"] });
  });

  it("with a base that requires nothing, waits only for what the host reports", () => {
    expect(evaluateChecks([], [])).toEqual({ state: "passed" });
    expect(evaluateChecks([check("lint", "pending")], [])).toEqual({
      state: "pending",
      waiting: ["lint"],
    });
  });
});

describe("the required set", () => {
  it("joins the base's names with the checks the host marks required", () => {
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
    expect(requiredCheckStates([check("ci-ok", "pass")], BASE)).toEqual([
      { name: "ci-ok", state: "pass" },
      { name: "pr-title", state: "pending" },
    ]);
    expect(checksFinal([check("ci-ok", "pass")], BASE)).toBe(false);
  });

  it("is final when all passed, or when one failed and none is pending", () => {
    expect(checksFinal([check("ci-ok", "pass"), check("pr-title", "pass")], BASE)).toBe(true);
    expect(checksFinal([check("ci-ok", "fail"), check("pr-title", "pass")], BASE)).toBe(true);
    expect(checksFinal([check("ci-ok", "fail"), check("pr-title", "pending")], BASE)).toBe(false);
    expect(checksFinal([check("ci-ok", "fail")], BASE)).toBe(false);
  });
});
