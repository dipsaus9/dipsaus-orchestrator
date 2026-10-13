// CI only (0017 section 1): `dipo daemon wait-pid` against a live process that exits while it
// waits (DIPO-63), moved out of the local suite for its time budget (DIPO-79): the wait polls once a
// second, so the case costs about a second. The fast local version, a process already gone, is in
// index.test.ts; the polling itself is tested with the manual clock in the engine's keepawake tests.

import { describe, expect, it } from "bun:test";

import { runDaemon } from "./index";

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("runDaemon", () => {
    it("dispatches wait-pid, which exits 0 once the process is gone (DIPO-63)", async () => {
      // A real short-lived process stands in for the daemon.
      const sleeper = Bun.spawn({ cmd: ["sleep", "0.2"], stdin: "ignore", stdout: "ignore" });
      const err: string[] = [];
      const io = {
        writeLine: () => {},
        writeError: (line: string) => err.push(line),
        env: {},
        execArgv: [],
      };
      const [code] = await Promise.all([
        runDaemon(["wait-pid", String(sleeper.pid)], io),
        sleeper.exited,
      ]);
      expect(code).toBe(0);
      expect(err).toEqual([]);
    });
  });
}
