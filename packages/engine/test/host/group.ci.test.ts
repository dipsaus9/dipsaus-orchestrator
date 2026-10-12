// CI only (0017 section 1): real processes. A worker that leaves a background child behind
// leaves no process once `exit.json` exists: the host kills the worker's process group when the
// worker exits (DIPO-44 AC #4).

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir } from "@dipsaus-orchestrator/testkit";

import { runWorkerHost } from "../../src/host/main";
import { EXIT_FILE, hostSocketPath, LAUNCH_FILE, type HostLaunch } from "../../src/host/protocol";
import { systemClock } from "../../src/platform/clock";
import { pidExists, signalGroup, systemSpawn } from "../../src/platform/process";

const RUN = "run_01JZ0000000000000000000001";

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("worker host process group", () => {
    it(
      "kills a background child of the worker before exit.json appears",
      () =>
        withTempDir(async (dir) => {
          const runDir = join(dir, "runs", RUN);
          mkdirSync(runDir, { recursive: true });
          const childPidFile = join(dir, "child.pid");
          const launch: HostLaunch = {
            version: 1,
            run: RUN,
            agent: "agt_01JZ0000000000000000000001",
            socket: hostSocketPath(join(dir, "rt"), RUN),
            plan: {
              argv: [
                "/bin/sh",
                "-c",
                `sleep 300 & echo $! > '${childPidFile}'; echo '{"type":"stub"}'; exit 0`,
              ],
              env: { PATH: "/usr/bin:/bin" },
              cwd: dir,
              files: [],
              stdin: [],
            },
          };
          writeFileSync(join(runDir, LAUNCH_FILE), JSON.stringify(launch));
          let child: number | undefined;
          try {
            const code = await runWorkerHost({
              runId: RUN,
              runDir,
              clock: systemClock,
              spawn: systemSpawn,
              killGroup: (pgid, signal) => {
                signalGroup(pgid, signal);
              },
              pid: process.pid,
            });
            expect(code).toBe(0);
            expect(existsSync(join(runDir, EXIT_FILE))).toBe(true);
            child = Number(readFileSync(childPidFile, "utf8").trim());
            // The killed child is reaped by init; give it a moment.
            const deadline = performance.now() + 3000;
            while (performance.now() < deadline && pidExists(child)) await Bun.sleep(20);
            expect(pidExists(child)).toBe(false);
          } finally {
            if (child !== undefined && pidExists(child)) process.kill(child, "SIGKILL");
          }
        }),
      20_000,
    );
  });
}
