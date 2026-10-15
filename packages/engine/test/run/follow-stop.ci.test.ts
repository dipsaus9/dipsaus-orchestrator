// CI only (0017 section 1): real processes (DIPO-93 AC #5). A real `dipo daemon worker-host`
// started detached through the engine runs a stub worker; its socket is removed and its row set to
// follow-only, as after a restart whose host socket did not answer. The stop sequence then reaches
// it as one SIGTERM to the verified host PID: the host stops its worker and writes `exit.json`.
// A host whose recorded start time does not match is never signalled and keeps running.

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

import { EXIT_FILE, type HostExitFile } from "../../src/host/protocol";
import { systemClock } from "../../src/platform/clock";
import { currentPlatform } from "../../src/platform/paths";
import { pidExists, signalProcess, systemProcessProbe } from "../../src/platform/process";
import { hostSocketSteering } from "../../src/run";
import { hostAlive, type LaunchedHost, startWorkerHost } from "../../src/runs/worker-hosts";
import { encode } from "../../src/workers/claude-cli/encode";
import { addOffice, openTestState } from "../commands/helpers";

const FIXTURES = resolve(import.meta.dir, "../host/fixtures");
const CLI_MAIN = resolve(import.meta.dir, "../../../cli/src/main.ts");
const RUNS = ["run_01JZ0000000000000000000001", "run_01JZ0000000000000000000002"];

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
  if (pid === undefined || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("stopping a follow-only host by signal (DIPO-93)", () => {
    it(
      "sends one SIGTERM to the verified host, which stops its worker and writes exit.json; an unverified host is left alone",
      () =>
        withTempDir(async (dir) => {
          const t = await openTestState(dir);
          const office = addOffice(t);
          const probe = systemProcessProbe(currentPlatform());
          const env = cleanEnv();
          delete env["BUN_OPTIONS"];
          delete env["BUN_FEATURE_FLAG_NO_ORPHANS"];
          const hosts: LaunchedHost[] = [];
          const workers: number[] = [];
          try {
            for (const [index, runId] of RUNS.entries()) {
              const work = join(dir, `w${index}`);
              mkdirSync(work, { recursive: true });
              const stub = join(work, "s.sh");
              copyFileSync(join(FIXTURES, "stub-worker.sh"), stub);
              chmodSync(stub, 0o755);
              // The stub writes worker.pid and waits for `release` next to it.
              const host = await startWorkerHost(office, t.clock, {
                runId,
                agentId: `agt_01JZ000000000000000000000${index + 1}`,
                officeDir: join(dir, "repo", ".git", "dipo"),
                runtimeDir: join(dir, "rt"),
                plan: {
                  argv: ["/bin/sh", stub],
                  env: { PATH: "/usr/bin:/bin" },
                  cwd: dir,
                  files: [],
                  stdin: ['"first"\n'],
                },
                dipoCommand: [process.execPath, CLI_MAIN],
                env: { ...env, DIPO_HOME: join(dir, "state"), DIPO_TMP: dir },
                probe,
                systemdScope: false,
              });
              hosts.push(host);
              workers.push(
                await waitFor("worker.pid", () => {
                  const path = join(work, "worker.pid");
                  const text = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
                  return text === "" ? null : Number(text);
                }),
              );
              // Follow-only, as after a restart: the socket is gone and the row says so.
              rmSync(host.socketPath, { force: true });
              office.immediate(() =>
                office.run(
                  "update worker_hosts set mode = 'follow' where office_id = $office_id and run_id = $run",
                  { run: runId },
                ),
              );
            }
            const [good, bad] = hosts as [LaunchedHost, LaunchedHost];
            // The second host's row names another start time: as if its PID had been reused.
            office.immediate(() =>
              office.run(
                "update worker_hosts set start_time_ms = start_time_ms - 60000 where office_id = $office_id and run_id = $run",
                { run: bad.runId },
              ),
            );
            const steering = hostSocketSteering({
              clock: systemClock,
              probe,
              signal: signalProcess,
            });

            const refused = await steering.send(
              office,
              bad.runId as never,
              encode({ kind: "stop" }),
            );
            expect(refused.ok).toBe(false);
            expect(refused.ok ? "" : refused.reason).toContain("dipo sent no signal");

            expect(
              await steering.send(office, good.runId as never, encode({ kind: "stop" })),
            ).toEqual({
              ok: true,
              via: "signal",
            });
            const exit = await waitFor("exit.json", () =>
              readJson<HostExitFile>(join(good.runDir, EXIT_FILE)),
            );
            // The stub sh dies of the SIGTERM the host sent its worker.
            expect(exit).toMatchObject({ run: good.runId, signal: "SIGTERM" });
            const events = readFileSync(join(good.runDir, "events.ndjson"), "utf8");
            expect(events).toContain('"ch":"exit"');
            const deadline = performance.now() + 10_000;
            while (performance.now() < deadline && (await hostAlive(good, probe))) {
              await Bun.sleep(50);
            }
            expect(await hostAlive(good, probe)).toBe(false);
            expect(pidExists(workers[0] ?? -1)).toBe(false);
            expect(readFileSync(join(good.runDir, "host.log"), "utf8")).toContain(
              "SIGTERM received; stopping the worker",
            );

            // The unverified host was never signalled: it and its worker still run.
            await Bun.sleep(300);
            expect(await hostAlive(bad, probe)).toBe(true);
            expect(pidExists(workers[1] ?? -1)).toBe(true);
            expect(existsSync(join(bad.runDir, EXIT_FILE))).toBe(false);
            writeFileSync(join(dir, "w1", "release"), "");
            await waitFor("the second exit.json", () =>
              readJson<HostExitFile>(join(bad.runDir, EXIT_FILE)),
            );
          } finally {
            for (const host of hosts) killGroup(host.pid);
            for (const worker of workers) killGroup(worker);
            t.state.close();
          }
        }),
      60_000,
    );
  });
}
