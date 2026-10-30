// A daemon that does not hold `dipo.pid` never takes another daemon's place (0005, DIPO-355):
// - a starter that lost the lock before it chose its place leaves the winner's bound socket in
//   place, so the winner still answers;
// - a running daemon whose `dipo.pid` now holds another record drains at the next tick of its
//   upgrade check and exits 1, leaving the record and the socket path to the other daemon.
// The daemon runs in-process on the manual clock, with a fake source for uncaught errors; state,
// runtime and temp files stay under the test's temp directory.

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "@dipsaus-orchestrator/engine/platform";
import {
  isolatedDaemonEnv,
  ManualClock,
  testRuntimeDir,
  withDaemonTempDir,
} from "@dipsaus-orchestrator/testkit";

import { choosePlace, runForeground } from "../../src/foreground";
import type { DaemonIo } from "../../src/io";
import { UPGRADE_CHECK_MS } from "../../src/upgrade";

describe("a daemon that lost dipo.pid", () => {
  it("leaves the winner's socket in place when it lost the lock before choosing its place", () =>
    withDaemonTempDir(async (dir) => {
      const env = isolatedDaemonEnv(dir);
      const run = testRuntimeDir(dir);
      mkdirSync(run, { recursive: true, mode: 0o700 });
      const socket = join(run, "dipo.sock");
      // The winner, bound on the socket path.
      const winner = Bun.serve({ unix: socket, fetch: () => new Response("winner") });
      try {
        const clock = new ManualClock();
        const io = { env, clock } as unknown as DaemonIo;
        const logger = createLogger({ clock, sinks: [], component: "test" });
        let recorded = false;
        const lost = {
          path: join(dir, "state", "dipo.pid"),
          holds: () => false,
          setRuntimeDir: () => {
            recorded = true;
          },
        };
        expect(choosePlace({ io, logger }, lost)).toBeNull();
        expect(recorded).toBe(false);
        expect(existsSync(socket)).toBe(true);
        const answer = await fetch("http://localhost/", { unix: socket });
        expect(await answer.text()).toBe("winner");
      } finally {
        await winner.stop(true);
      }
    }));

  it("drains and exits 1 within one tick once dipo.pid holds another record", () =>
    withDaemonTempDir(async (dir) => {
      const clock = new ManualClock();
      const lines: string[] = [];
      const exited = runForeground([], {
        writeLine: () => {},
        writeError: (line) => lines.push(line),
        env: isolatedDaemonEnv(dir),
        execArgv: [],
        version: "test",
        clock,
        onShutdownSignal: () => () => {},
        // No listener for uncaught errors on the test runner's own process (DIPO-117).
        uncaughtErrors: new EventEmitter(),
      });
      let done = false;
      void exited.then(() => (done = true));
      for (let i = 0; i < 400 && !lines.some((line) => line.includes('"to":"running"')); i++) {
        await Bun.sleep(25);
      }
      expect(lines.some((line) => line.includes('"to":"running"'))).toBe(true);
      // Another daemon's record replaces this one's.
      const pidFile = join(dir, "state", "dipo.pid");
      const other = `${JSON.stringify({ pid: 1, startTimeMs: 1, version: "other", runtimeDir: null })}\n`;
      writeFileSync(pidFile, other);
      clock.advance(UPGRADE_CHECK_MS - 1);
      await Bun.sleep(50);
      expect(done).toBe(false);
      clock.advance(1);
      expect(await exited).toBe(1);
      expect(lines.some((line) => line.includes("no longer holds this daemon's record"))).toBe(
        true,
      );
      // The other daemon's record and the socket path are left alone.
      expect(readFileSync(pidFile, "utf8")).toBe(other);
      expect(existsSync(join(testRuntimeDir(dir), "dipo.sock"))).toBe(true);
    }));
});
