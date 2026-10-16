// CI only (0017 section 1; DIPO-70 test plan): `dipo daemon start`, `status`, `restart` and `stop`
// on the compiled binary in a temp DIPO_HOME, plus autostart through a command that needs the
// daemon, a stale `runtime.json`, and an invalid `config.yaml` that refuses the autostart. State,
// runtime directory and temp files stay under the test's temp directory (DIPO_HOME,
// DIPO_RUNTIME_DIR, DIPO_TMP), and a `finally` stops any daemon left running.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  daemonTestEnv,
  makeTempDir,
  removeTempDir,
  runCommand,
  withDaemonTempDir,
} from "@dipsaus-orchestrator/testkit";

const REPO = resolve(import.meta.dir, "../../../..");
const TIMEOUT_MS = 120_000;

async function dipo(bin: string, args: string[], env: Record<string, string>) {
  const child = Bun.spawn({
    cmd: [bin, ...args],
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

function pidOf(stdout: string): number {
  const match = /pid (\d+)/.exec(stdout);
  if (match?.[1] === undefined) throw new Error(`no pid in ${JSON.stringify(stdout)}`);
  return Number(match[1]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("dipo daemon lifecycle on the compiled binary", () => {
    it(
      "starts, reports, restarts and stops the daemon, and autostarts it for a command",
      async () => {
        const binDir = makeTempDir();
        try {
          const bin = join(binDir, "dipo");
          const built = await runCommand([process.execPath, "scripts/build.ts", "--outfile", bin], {
            cwd: REPO,
            env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          });
          expect(built.exitCode).toBe(0);

          // Every daemon this test starts must log DIPO_RUNTIME_DIR as its runtime source (DIPO-109).
          await withDaemonTempDir(async (dir) => {
            const state = join(dir, "state");
            const env = {
              ...daemonTestEnv(dir),
              // AC #11: a client started under --no-orphans does not pass it to the daemon.
              BUN_FEATURE_FLAG_NO_ORPHANS: "1",
            };
            const pids: number[] = [];
            try {
              const none = await dipo(bin, ["daemon", "status"], env);
              expect(none.code).toBe(3);
              expect(none.stdout).toStartWith("not running\n");
              expect(none.stdout).toContain("autostart:  not installed");

              const started = await dipo(bin, ["daemon", "start"], env);
              expect(started.code).toBe(0);
              expect(started.stdout).toStartWith("dipo daemon started (pid ");
              const first = pidOf(started.stdout);
              pids.push(first);

              const status = await dipo(bin, ["daemon", "status"], env);
              expect(status.code).toBe(0);
              expect(status.stdout).toStartWith("running\n");
              expect(status.stdout).toContain(`  pid:        ${first}\n`);
              expect(status.stdout).toContain("    git     /");

              const json = await dipo(bin, ["daemon", "status", "--json"], env);
              expect(json.code).toBe(0);
              const parsed = JSON.parse(json.stdout) as {
                status: string;
                daemon: { pid: number; tools: Record<string, string> };
              };
              expect(parsed.status).toBe("running");
              expect(parsed.daemon.pid).toBe(first);
              expect(parsed.daemon.tools["git"]).toStartWith("/");

              const again = await dipo(bin, ["daemon", "start"], env);
              expect(again.stdout).toStartWith(`dipo daemon is already running (pid ${first}`);

              const restarted = await dipo(bin, ["daemon", "restart"], env);
              expect(restarted.code).toBe(0);
              expect(restarted.stdout).toContain(`dipo daemon stopped (pid ${first})`);
              const second = pidOf(restarted.stdout.split("\n")[1] ?? "");
              pids.push(second);
              expect(second).not.toBe(first);
              expect(alive(first)).toBe(false);

              const stopped = await dipo(bin, ["daemon", "stop"], env);
              expect(stopped).toMatchObject({
                code: 0,
                stdout: `dipo daemon stopped (pid ${second})\n`,
              });
              expect(alive(second)).toBe(false);
              expect(existsSync(join(state, "runtime.json"))).toBe(false);

              // Stale runtime.json without dipo.pid: stale, then not running.
              writeFileSync(
                join(state, "runtime.json"),
                JSON.stringify({
                  runtimeDir: "/nope",
                  socket: "/nope/dipo.sock",
                  pid: 999_999,
                  startTimeMs: 1,
                  version: "x",
                }),
              );
              const stale = await dipo(bin, ["daemon", "status"], env);
              expect(stale.code).toBe(3);
              expect(stale.stdout).toStartWith("stale\n");
              expect((await dipo(bin, ["daemon", "status"], env)).stdout).toStartWith(
                "not running\n",
              );

              // An invalid config.yaml refuses the autostart instead of a daemon that exits 78.
              writeFileSync(
                join(state, "config.yaml"),
                "version: 1\ndaemon:\n  autostart: maybe\n",
              );
              const refused = await dipo(bin, ["daemon", "log-level", "debug"], env);
              expect(refused.code).toBe(1);
              expect(refused.stderr).toContain("daemon.autostart");
              expect((await dipo(bin, ["daemon", "status"], env)).code).toBe(3);

              // Autostart through a command that needs the daemon.
              writeFileSync(join(state, "config.yaml"), "version: 1\n");
              const auto = await dipo(bin, ["daemon", "log-level", "debug"], env);
              expect(auto.code).toBe(0);
              expect(auto.stderr).toContain("dipo: started the daemon (pid ");
              pids.push(pidOf(auto.stderr));
              expect(auto.stdout).toBe("daemon log level: debug (until the daemon restarts)\n");

              const forced = await dipo(bin, ["daemon", "stop", "--force"], env);
              expect(forced.code).toBe(0);
              expect(readFileSync(join(state, "logs", "daemon.log"), "utf8")).toContain(
                "tools resolved",
              );
            } finally {
              for (const pid of pids) {
                if (alive(pid)) process.kill(pid, "SIGKILL");
              }
            }
          });
        } finally {
          removeTempDir(binDir);
        }
      },
      TIMEOUT_MS,
    );
  });
}
