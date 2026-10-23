import { describe, expect, it } from "bun:test";

import { CI_TEST_TIMEOUT_MS, LOCAL_TEST_TIMEOUT_MS, testArgs, testTimeout } from "./test";

describe("the test runner's per-test timeout (DIPO-335)", () => {
  it("gives every test 30 s in CI and keeps Bun's 5 s elsewhere", () => {
    expect(CI_TEST_TIMEOUT_MS).toBe(30_000);
    expect(LOCAL_TEST_TIMEOUT_MS).toBe(5_000);
    expect(testTimeout({ DIPO_TEST_CI: "1" })).toBe(30_000);
    for (const value of [undefined, "", "0", "true"]) {
      expect(testTimeout({ DIPO_TEST_CI: value })).toBe(5_000);
    }
  });

  it("passes the timeout on the command line and keeps the caller's arguments", () => {
    expect(testArgs(["packages/engine"], { DIPO_TEST_CI: "1" })).toEqual([
      "test",
      "--timeout=30000",
      "packages/engine",
    ]);
    expect(testArgs([], {})).toEqual(["test", "--timeout=5000"]);
  });
});
