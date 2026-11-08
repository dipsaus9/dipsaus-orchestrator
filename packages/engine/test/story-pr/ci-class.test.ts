// Whose fault a failed check is (DIPO-465 test plan). The logs are trimmed copies of real
// `gh run view --log-failed` output (`test/fixtures/ci-logs/`): the HTTP 504 downloads of actionlint
// and the CodeQL bundle that parked DIPO-463 (runs 42467945689 and 42467941615) and PR #625 (run
// 42468041527), and earlier red heads of this repository for a test, a type and a lint failure.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { aggregateClass, classifyJobLog, failingStepLines } from "../../src/story-pr/ci-class";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "..", "fixtures", "ci-logs", name), "utf8");

describe("the class of a failed Actions job", () => {
  it("is infrastructure for the HTTP 504 downloads of DIPO-463's and PR #625's red heads", () => {
    for (const name of [
      "dipo-463-actionlint-504.log",
      "dipo-463-codeql-bundle-504.log",
      "pr-625-actionlint-504.log",
    ]) {
      expect({ name, class: classifyJobLog(fixture(name)) }).toEqual({ name, class: "infra" });
    }
  });

  it("is the code's for a test, a type and a lint failure", () => {
    for (const name of ["test-failure.log", "type-failure.log", "lint-failure.log"]) {
      expect({ name, class: classifyJobLog(fixture(name)) }).toEqual({ name, class: "code" });
    }
  });

  it("reads the failing step's error, not the steps before it or the job's cleanup", () => {
    const lines = failingStepLines(fixture("dipo-463-actionlint-504.log"));
    expect(lines).toContain("curl: (22) The requested URL returned error: 504");
    expect(lines.at(-1)).toBe("##[error]Process completed with exit code 22.");
    expect(lines.some((line) => line.includes("Post job cleanup"))).toBe(false);
    const codeql = failingStepLines(fixture("dipo-463-codeql-bundle-504.log"));
    expect(codeql).toContain(
      "##[error]Unable to download and extract CodeQL CLI: Unexpected HTTP response: 504",
    );
    expect(codeql.some((line) => line.includes("CodeQL job status was failure"))).toBe(false);
  });

  it("is the code's when a 504 is printed outside the failing step's error, or with a test failure", () => {
    // An earlier step printed the 504 of a retried download that then passed; the test step failed.
    const retried = fixture("dipo-463-actionlint-504.log")
      .split("\n")
      .filter((line) => !line.includes("##[error]"))
      .join("\n");
    expect(classifyJobLog(`${retried}${fixture("test-failure.log")}`)).toBe("code");
    const late = fixture("test-failure.log").replace(
      " --seed=",
      "Unexpected HTTP response: 504\n --seed=",
    );
    // A 504 in a failing test's own output is the code's: the test failed.
    expect(classifyJobLog(late)).toBe("code");
  });

  it("is the code's for a log that matches no pattern, an empty log and no log", () => {
    // ci-ok's own log says only which needed job failed.
    expect(classifyJobLog(fixture("dipo-463-ci-ok-after-actionlint.log"))).toBe("code");
    expect(classifyJobLog(fixture("pr-625-ci-ok-after-actionlint.log"))).toBe("code");
    expect(classifyJobLog("")).toBe("code");
    expect(classifyJobLog(null)).toBe("code");
  });
});

describe("the class of an aggregate check", () => {
  it("is infrastructure only when every job that explains it is", () => {
    const actionlint = classifyJobLog(fixture("dipo-463-actionlint-504.log"));
    expect(aggregateClass([actionlint])).toBe("infra");
    expect(aggregateClass([actionlint, classifyJobLog(fixture("test-failure.log"))])).toBe("code");
    expect(aggregateClass([])).toBe("code");
  });
});
