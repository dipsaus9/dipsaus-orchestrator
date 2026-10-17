import { describe, expect, it } from "bun:test";

import { guardRuns } from "./guard";

describe("guardRuns", () => {
  it("writes one line naming the guard and the reason when the test skips", () => {
    const lines: string[] = [];
    const runs = guardRuns("PS_RUNS", "/bin/ps cannot read this process", false, (line) =>
      lines.push(line),
    );
    expect(runs).toBe(false);
    expect(lines).toEqual(["skipped by guard PS_RUNS: /bin/ps cannot read this process"]);
  });

  it("writes nothing when the test runs", () => {
    const lines: string[] = [];
    const runs = guardRuns("PS_RUNS", "/bin/ps cannot read this process", true, (line) =>
      lines.push(line),
    );
    expect(runs).toBe(true);
    expect(lines).toEqual([]);
  });
});
