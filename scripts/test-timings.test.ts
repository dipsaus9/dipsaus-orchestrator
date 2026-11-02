// The refresh of scripts/test-timings.json from a CI run's logs (DIPO-406).

import { describe, expect, it } from "bun:test";

import { jobOs, mergeTimings, parseLog } from "./test-timings";

/** A line of `gh run view --log`, with GitHub's 7-digit fraction, `seconds` after 08:00:00. */
function line(job: string, seconds: number, text: string, bom = false): string {
  const stamp = new Date(Date.UTC(2026, 9, 31, 8, 0, 0) + seconds * 1000).toISOString();
  return `${job}\tRun bun test\t${bom ? String.fromCharCode(0xfeff) : ""}${stamp.replace("Z", "0000Z")} ${text}`;
}

describe("parseLog", () => {
  it("takes each test file's time from its log group", () => {
    const log = [
      line("verify (1)", 0, "##[group]Run bun install --frozen-lockfile", true),
      line("verify (1)", 3, "##[endgroup]"),
      line("verify (1)", 4, "bun test v1.4.2"),
      line("verify (1)", 5, "##[group]packages/a/x.test.ts:"),
      line("verify (1)", 5.5, "(pass) x > works [0.10ms]"),
      line("verify (1)", 7.25, "##[endgroup]"),
      line("verify (1)", 7.5, "##[group]scripts/y.ci.test.ts:"),
      line("verify (1)", 9, "##[endgroup]"),
      line("verify (1)", 9.5, "##[group]not a test file:"),
      line("verify (1)", 20, "##[endgroup]"),
      "verify (1)\tRun bun test\tno time stamp here",
    ].join("\n");
    expect(parseLog(log)).toEqual({ "packages/a/x.test.ts": 2250, "scripts/y.ci.test.ts": 1500 });
  });

  it("drops a group that never closes", () => {
    expect(parseLog(line("verify (1)", 0, "##[group]a.test.ts:"))).toEqual({});
  });
});

describe("jobOs", () => {
  it("knows the shards and the unsharded jobs of before, and nothing else", () => {
    expect(jobOs("verify (2)")).toBe("Linux");
    expect(jobOs("verify")).toBe("Linux");
    expect(jobOs("verify-macos (4)")).toBe("macOS");
    expect(jobOs("verify-macos")).toBe("macOS");
    for (const name of ["checks", "smoke (darwin-arm64)", "test-shards", "verify-linux (1)"]) {
      expect(jobOs(name)).toBeUndefined();
    }
  });
});

describe("mergeTimings", () => {
  it("takes the new times, keeps old ones the run lacks, and drops files that are gone", () => {
    const old = {
      Linux: { "a.test.ts": 1, "b.test.ts": 2, "gone.test.ts": 3 },
      macOS: { "a.test.ts": 9 },
    };
    const fresh = { Linux: { "b.test.ts": 20, "c.test.ts": 30 } };
    const merged = mergeTimings(old, fresh, ["c.test.ts", "b.test.ts", "a.test.ts"]);
    expect(merged).toEqual({
      Linux: { "a.test.ts": 1, "b.test.ts": 20, "c.test.ts": 30 },
      macOS: { "a.test.ts": 9 },
    });
    expect(Object.keys(merged["Linux"] ?? {})).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
  });
});
