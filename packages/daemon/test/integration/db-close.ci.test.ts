// CI only (0017 section 1): a real daemon checkpoints and closes the state database on a clean stop
// (DIPO-87), so `<state>` keeps dipo.db and no dipo.db-wal or dipo.db-shm. The daemon is started
// with `dipo daemon --foreground` and stopped with `dipo daemon stop`. State, runtime and temp
// files stay under the test's temp directory, and the daemon is killed in a `finally` if needed.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

const MAIN = resolve(import.meta.dir, "../../../cli/src/main.ts");
const TIMEOUT_MS = 30_000;
/** The warn messages `closeCleanly` writes (packages/engine/src/platform/sqlite.ts). */
const CLOSE_WARNINGS = [
  "the closing checkpoint",
  "could not turn persistent WAL off",
  "could not close the state database",
];

type Line = { msg: string; level?: string; to?: string };

function daemonEnv(dir: string): Record<string, string> {
  const env = cleanEnv();
  delete env["BUN_OPTIONS"];
  delete env["DIPO_LOG"];
  return {
    ...env,
    DIPO_HOME: join(dir, "state"),
    DIPO_RUNTIME_DIR: join(dir, "run"),
    DIPO_TMP: dir,
  };
}

function readLog(dir: string): Line[] {
  const path = join(dir, "state", "logs", "daemon.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Line);
}

async function waitForRunning(dir: string, daemon: Bun.Subprocess): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`daemon exited with ${daemon.exitCode}`);
    if (readLog(dir).some((l) => l.msg === "daemon state" && l.to === "running")) return;
    await Bun.sleep(50);
  }
  throw new Error("daemon did not reach running within 10 s");
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("dipo daemon stop (real process, DIPO-87)", () => {
    it(
      "leaves dipo.db without a -wal or -shm file",
      () =>
        withTempDir(async (dir) => {
          const env = daemonEnv(dir);
          const state = join(dir, "state");
          const daemon = Bun.spawn({
            cmd: [process.execPath, MAIN, "daemon", "--foreground"],
            env,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          });
          try {
            await waitForRunning(dir, daemon);
            // The migrations wrote through the WAL; the sidecars exist while the daemon runs.
            expect(existsSync(join(state, "dipo.db-wal"))).toBe(true);

            const stopper = Bun.spawn({
              cmd: [process.execPath, MAIN, "daemon", "stop"],
              env,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            });
            expect(await stopper.exited).toBe(0);
            expect(await daemon.exited).toBe(0);

            expect(existsSync(join(state, "dipo.db"))).toBe(true);
            expect(existsSync(join(state, "dipo.db-wal"))).toBe(false);
            expect(existsSync(join(state, "dipo.db-shm"))).toBe(false);

            const log = readLog(dir);
            const messages = log.map((line) => line.msg);
            expect(messages).toContain("closed state database");
            expect(messages.indexOf("socket closed")).toBeLessThan(
              messages.indexOf("closed state database"),
            );
            // Other warns (a tool missing from PATH in CI) are not this story's; none of the close's.
            const closeWarns = log.filter(
              (line) => line.level === "warn" && CLOSE_WARNINGS.some((w) => line.msg.startsWith(w)),
            );
            expect(closeWarns).toEqual([]);
            expect(messages.at(-1)).toBe("daemon stopped");
          } finally {
            if (daemon.exitCode === null && daemon.signalCode === null) {
              daemon.kill("SIGKILL");
              await daemon.exited;
            }
          }
        }),
      TIMEOUT_MS,
    );
  });
}
