// CI only (0017 section 1, DIPO-225): a real `bun test` run whose second file waits 6 s, so the
// timeout really reaches a file that is not the first. The timeout rules themselves are unit tested
// in test.test.ts.

import { describe, expect, it } from "bun:test";

import { testArgs } from "./test";

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("the test runner's per-test timeout (DIPO-335)", () => {
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
}
