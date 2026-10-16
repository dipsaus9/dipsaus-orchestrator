// CI only (0017 section 1): a real daemon process drains on SIGTERM (DIPO-68, 0006 decision 7). It
// waits for a running child it started, removes `dipo.sock` and then `dipo.pid`, and at the drain
// cap kills the child's process group. State, runtime and temp files stay under the test's temp
// directory, and every process is stopped in a `finally`.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  assertTestRuntimeDir,
  daemonTestEnv,
  withDaemonTempDir,
} from "@dipsaus-orchestrator/testkit";

const FIXTURE = resolve(import.meta.dir, "fixtures/drain-daemon.ts");
const TIMEOUT_MS = 30_000;

type Line = { msg: string; to?: string; reason?: string; childPid?: number; removed?: boolean };

function readLog(dir: string): Line[] {
  const path = join(dir, "state", "logs", "daemon.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Line);
}

function start(dir: string, command: string, capMs: number) {
  return Bun.spawn({
    cmd: [process.execPath, FIXTURE, command, String(capMs)],
    env: daemonTestEnv(dir),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function waitForRunning(dir: string, daemon: Bun.Subprocess): Promise<number> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    // A daemon that chose a runtime directory outside `dir` fails the test (DIPO-109).
    assertTestRuntimeDir(dir);
    if (daemon.exitCode !== null) throw new Error(`daemon exited with ${daemon.exitCode}`);
    const log = readLog(dir);
    const child = log.find((line) => line.msg === "test child started")?.childPid;
    if (child !== undefined && log.some((l) => l.msg === "daemon state" && l.to === "running")) {
      return child;
    }
    await Bun.sleep(50);
  }
  throw new Error("daemon did not reach running within 10 s");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanup(daemon: Bun.Subprocess, pids: number[]): Promise<void> {
  if (daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill("SIGKILL");
    await daemon.exited;
  }
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("dipo daemon drain (real process)", () => {
    it(
      "waits on SIGTERM for a running child, then removes dipo.sock and then dipo.pid",
      () =>
        withDaemonTempDir(async (dir) => {
          const done = join(dir, "child-done");
          const daemon = start(dir, `sleep 2; touch "${done}"`, 20_000);
          let child = 0;
          try {
            child = await waitForRunning(dir, daemon);
            expect(existsSync(join(dir, "run", "dipo.sock"))).toBe(true);
            daemon.kill("SIGTERM");
            expect(await daemon.exited).toBe(0);
            // The child finished its work before the daemon exited: it was waited for.
            expect(existsSync(done)).toBe(true);
            expect(alive(child)).toBe(false);
            expect(existsSync(join(dir, "run", "dipo.sock"))).toBe(false);
            expect(existsSync(join(dir, "state", "dipo.pid"))).toBe(false);

            const log = readLog(dir);
            const messages = log.map((line) => line.msg);
            const draining = log.find((l) => l.msg === "daemon state" && l.to === "draining");
            expect(draining?.reason).toBe("SIGTERM");
            expect(messages).toContain("drained");
            expect(messages).not.toContain("the drain reached its cap");
            expect(log.find((l) => l.msg === "socket closed")?.removed).toBe(true);
            expect(messages.indexOf("drained")).toBeLessThan(messages.indexOf("socket closed"));
            expect(messages.indexOf("socket closed")).toBeLessThan(
              messages.indexOf("lock released"),
            );
            expect(messages.at(-1)).toBe("daemon stopped");
            // A clean exit leaves no crash for the next start.
            const crashes = JSON.parse(readFileSync(join(dir, "state", "crashes.json"), "utf8"));
            expect(crashes).toMatchObject({ running: null, crashes: [] });
          } finally {
            await cleanup(daemon, child === 0 ? [] : [child]);
          }
        }),
      TIMEOUT_MS,
    );

    it(
      "kills the process group of a child still running at the drain cap and exits anyway",
      () =>
        withDaemonTempDir(async (dir) => {
          const grandchildFile = join(dir, "grandchild.pid");
          const daemon = start(dir, `sleep 60 & echo $! > "${grandchildFile}"; wait`, 1000);
          let child = 0;
          try {
            child = await waitForRunning(dir, daemon);
            for (let i = 0; i < 100 && !existsSync(grandchildFile); i++) await Bun.sleep(20);
            const grandchild = Number(readFileSync(grandchildFile, "utf8").trim());
            expect(alive(grandchild)).toBe(true);

            daemon.kill("SIGTERM");
            expect(await daemon.exited).toBe(0);
            for (let i = 0; i < 100 && (alive(child) || alive(grandchild)); i++) {
              await Bun.sleep(20);
            }
            expect(alive(child)).toBe(false);
            expect(alive(grandchild)).toBe(false);
            const messages = readLog(dir).map((line) => line.msg);
            expect(messages).toContain("the drain reached its cap; exiting anyway");
            expect(existsSync(join(dir, "run", "dipo.sock"))).toBe(false);
            expect(existsSync(join(dir, "state", "dipo.pid"))).toBe(false);
          } finally {
            await cleanup(daemon, child === 0 ? [] : [child]);
          }
        }),
      TIMEOUT_MS,
    );
  });
}
