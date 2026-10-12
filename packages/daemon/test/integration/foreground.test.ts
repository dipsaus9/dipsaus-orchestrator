// `dipo daemon --foreground` as real processes (DIPO-23): two starters race for the lock and exactly
// one runs; a stale record with a dead PID is broken. State, runtime directory and temp files stay
// under the test's temp directory (DIPO_HOME, DIPO_RUNTIME_DIR, DIPO_TMP), and every daemon is
// stopped in a `finally`.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

const MAIN = resolve(import.meta.dir, "../../../cli/src/main.ts");
const TIMEOUT_MS = 20_000;

type Daemon = Bun.Subprocess<"ignore", "pipe", "pipe">;

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

function start(env: Record<string, string>): Daemon {
  return Bun.spawn({
    cmd: [process.execPath, MAIN, "daemon", "--foreground"],
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Waits until the daemon answers on its socket with its own PID and has opened the database. */
async function waitUntilServing(dir: string, daemon: Daemon): Promise<void> {
  const deadline = performance.now() + 10_000;
  const socket = join(dir, "run", "dipo.sock");
  const log = join(dir, "state", "logs", "daemon.log");
  while (performance.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`daemon exited with ${daemon.exitCode}`);
    try {
      const response = await fetch("http://dipo/", { unix: socket });
      const body = (await response.json()) as { pid: number };
      const opened = readFileSync(log, "utf8").includes("opened state database");
      if (body.pid === daemon.pid && opened) return;
    } catch {
      // Not bound yet.
    }
    await Bun.sleep(50);
  }
  throw new Error("daemon did not start serving within 10 s");
}

async function stop(daemon: Daemon): Promise<number | null> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return daemon.exitCode;
  daemon.kill("SIGTERM");
  const exited = await Promise.race([daemon.exited, Bun.sleep(5000).then(() => "timeout")]);
  if (exited === "timeout") {
    daemon.kill("SIGKILL");
    await daemon.exited;
    return null;
  }
  return daemon.exitCode;
}

describe("dipo daemon --foreground", () => {
  it(
    "lets exactly one of two racing starters run, and cleans up on SIGTERM",
    async () => {
      await withTempDir(async (dir) => {
        const env = daemonEnv(dir);
        const daemons = [start(env), start(env)];
        try {
          const loser = await Promise.race(daemons.map((d) => d.exited.then(() => d)));
          const winner = daemons.find((d) => d !== loser);
          if (winner === undefined) throw new Error("no winner");
          expect(loser.exitCode).toBe(0);
          expect(await new Response(loser.stdout).text()).toContain(
            `dipo daemon is already running (pid ${winner.pid}`,
          );

          await waitUntilServing(dir, winner);
          const state = join(dir, "state");
          const pidRecord = JSON.parse(readFileSync(join(state, "dipo.pid"), "utf8")) as {
            pid: number;
            runtimeDir: string;
          };
          expect(pidRecord).toMatchObject({ pid: winner.pid, runtimeDir: join(dir, "run") });
          const runtime = JSON.parse(readFileSync(join(state, "runtime.json"), "utf8")) as {
            socket: string;
          };
          expect(runtime.socket).toBe(join(dir, "run", "dipo.sock"));
          expect(existsSync(join(state, "dipo.db"))).toBe(true);

          expect(await stop(winner)).toBe(0);
          expect(existsSync(join(state, "dipo.pid"))).toBe(false);
          expect(existsSync(join(dir, "run", "dipo.sock"))).toBe(false);

          const log = readFileSync(join(state, "logs", "daemon.log"), "utf8");
          const messages = log
            .trim()
            .split("\n")
            .map((line) => (JSON.parse(line) as { msg: string }).msg);
          expect(messages).toContain("opened state database");
          expect(messages.at(-1)).toBe("daemon stopped");
          // The database opens only after the post-bind re-read: after "listening".
          expect(messages.indexOf("listening")).toBeLessThan(
            messages.indexOf("opened state database"),
          );
          // Foreground also writes the log lines to stderr.
          expect(await new Response(winner.stderr).text()).toContain('"msg":"daemon stopped"');
        } finally {
          await Promise.all(daemons.map(stop));
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "breaks a stale lock left by a dead process",
    async () => {
      await withTempDir(async (dir) => {
        const env = daemonEnv(dir);
        const dead = Bun.spawn({ cmd: ["true"], stdout: "ignore", stderr: "ignore" });
        await dead.exited;
        const state = join(dir, "state");
        await Bun.write(join(state, "logs", ".keep"), "");
        writeFileSync(
          join(state, "dipo.pid"),
          `${JSON.stringify({ pid: dead.pid, startTimeMs: 1, version: "old", runtimeDir: null })}\n`,
        );
        const daemon = start(env);
        try {
          await waitUntilServing(dir, daemon);
          const record = JSON.parse(readFileSync(join(state, "dipo.pid"), "utf8")) as {
            pid: number;
          };
          expect(record.pid).toBe(daemon.pid);
          expect(readFileSync(join(state, "logs", "daemon.log"), "utf8")).toContain(
            "found a stale daemon lock",
          );
        } finally {
          expect(await stop(daemon)).toBe(0);
        }
      });
    },
    TIMEOUT_MS,
  );
});
