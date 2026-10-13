// The required checks a PR waits for in the merge slot (DIPO-73; 0016 rule 2): `ci-ok` and
// `pr-title` must pass, any failed or cancelled required check fails, and a check the host has not
// reported yet is pending.

import { describe, expect, it } from "bun:test";

import { evaluateChecks, REQUIRED_CHECKS } from "../../src/merge-slot";
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
