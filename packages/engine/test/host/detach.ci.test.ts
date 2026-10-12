// CI only (0017 section 1): real processes. A worker host started by a daemon survives SIGKILL of
// that daemon together with its worker, and writes `exit.json` once the worker ends
// (0006 decision 8). A stub script stands in for Claude (DIPO-15 M0 review).

import { describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

import { currentPlatform } from "../../src/platform/paths";
import { pidExists, systemProcessProbe } from "../../src/platform/process";
import { EXIT_FILE, type HostExitFile } from "../../src/host/protocol";
import { hostAlive, type LaunchedHost } from "../../src/runs/worker-hosts";

const FIXTURES = resolve(import.meta.dir, "fixtures");
const RUN = "run_01JZ0000000000000000000001";

async function waitFor<T>(what: string, read: () => T | null, ms = 15_000): Promise<T> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("worker host detach", () => {
    it(
      "keeps the host and the worker running after SIGKILL of the daemon",
      () =>
        withTempDir(async (dir) => {
          const stub = join(dir, "stub-worker.sh");
          copyFileSync(join(FIXTURES, "stub-worker.sh"), stub);
          chmodSync(stub, 0o755);
          const env = cleanEnv();
          delete env["BUN_OPTIONS"];
          delete env["BUN_FEATURE_FLAG_NO_ORPHANS"];
          const daemon = Bun.spawn({
            cmd: [process.execPath, join(FIXTURES, "host-daemon.ts"), dir, RUN],
            env: { ...env, DIPO_TMP: dir, DIPO_HOME: join(dir, "state") },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "inherit",
          });
          let host: (LaunchedHost & { daemonPid: number }) | null = null;
          let workerPid: number | undefined;
          try {
            host = await waitFor("host.json", () =>
              readJson<LaunchedHost & { daemonPid: number }>(join(dir, "host.json")),
            );
            const runDir = host.runDir;
            workerPid = await waitFor("worker.pid", () => {
              const path = join(dir, "worker.pid");
              const text = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
              return text === "" ? null : Number(text);
            });

            daemon.kill("SIGKILL");
            await daemon.exited;
            await Bun.sleep(300);
            const probe = systemProcessProbe(currentPlatform());
            expect(await hostAlive(host, probe)).toBe(true);
            expect(pidExists(workerPid)).toBe(true);
            expect(existsSync(join(runDir, EXIT_FILE))).toBe(false);

            writeFileSync(join(dir, "release"), "");
            const exit = await waitFor("exit.json", () =>
              readJson<HostExitFile>(join(runDir, EXIT_FILE)),
            );
            expect(exit).toMatchObject({ run: RUN, code: 0, signal: null });
            const events = readFileSync(join(runDir, "events.ndjson"), "utf8");
            expect(events).toContain('{\\"type\\":\\"stub\\",\\"first\\":\\"first\\"}');
            expect(events).toContain('{\\"type\\":\\"done\\"}');
            const live = host;
            const deadline = performance.now() + 10_000;
            while (performance.now() < deadline && (await hostAlive(live, probe))) {
              await Bun.sleep(50);
            }
            expect(await hostAlive(live, probe)).toBe(false);
          } finally {
            if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
            killGroup(host?.pid);
            killGroup(workerPid);
          }
        }),
      40_000,
    );
  });
}
