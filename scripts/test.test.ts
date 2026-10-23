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

  it("applies the timeout to a test file that is not the first of the run", async () => {
    const dir = `${process.env["DIPO_TMP"] ?? "/tmp"}/dipo-335-${process.pid}`;
    await Bun.write(`${dir}/a.test.ts`, 'import { it } from "bun:test";\nit("a", () => {});\n');
    await Bun.write(
      `${dir}/b.test.ts`,
      'import { it } from "bun:test";\nit("b waits 6 s", async () => { await Bun.sleep(6000); });\n',
    );
    try {
      const run = Bun.spawn(
        [
          process.execPath,
          ...testArgs([`${dir}/a.test.ts`, `${dir}/b.test.ts`], { DIPO_TEST_CI: "1" }),
        ],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      expect(await run.exited).toBe(0);
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  }, 30_000);
});
