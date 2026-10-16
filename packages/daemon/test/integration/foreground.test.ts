// `dipo daemon --foreground` as real processes (DIPO-23): two starters race for the lock and exactly
// one runs; a stale record with a dead PID is broken. State, runtime directory and temp files stay
// under the test's temp directory (DIPO_HOME, DIPO_RUNTIME_DIR, DIPO_TMP), and every daemon is
// stopped in a `finally`.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { prepareRunTempDir, runTempOwner } from "@dipsaus-orchestrator/engine";
import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

import { TestClient } from "../support/client";

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

/**
 * Waits until the daemon answers engine.hello and daemon.status with its own PID, has opened the
 * database and has finished recovery. The database opens inside the first recovery step, so the
 * log line alone comes before the `recovering -> running` transition, and a test that reads the
 * software stream right after would race it (DIPO-68).
 */
async function waitUntilServing(dir: string, daemon: Daemon): Promise<void> {
  const deadline = performance.now() + 10_000;
  const socket = join(dir, "run", "dipo.sock");
  const log = join(dir, "state", "logs", "daemon.log");
  while (performance.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`daemon exited with ${daemon.exitCode}`);
    try {
      const client = await TestClient.connect(socket);
      try {
        await client.hello();
        const status = await client.read("daemon.status");
        const result = status.ok ? (status.result as { pid: number; state: string }) : null;
        const opened = readFileSync(log, "utf8").includes("opened state database");
        const recovered = result?.state === "running" || result?.state === "safe";
        if (result?.pid === daemon.pid && opened && recovered) return;
      } finally {
        await client.close();
      }
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
          // Re-attach is a recovery step after reconcile (DIPO-57 AC #8); the run temp directory
          // sweep follows it (DIPO-102).
          const steps = log
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { msg: string; step?: string })
            .filter((line) => line.msg === "recovery step")
            .map((line) => line.step);
          expect(steps).toEqual(["migrations", "reconcile", "reattach", "run-temp-sweep"]);
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
    "removes its own unknown runs' temp directories at start and leaves another daemon's",
    async () => {
      await withTempDir(async (dir) => {
        // Directories a killed daemon of this state left (its owner file names this database),
        // another daemon's (another owner) and one from before owner files: only the first goes.
        const owner = runTempOwner(join(dir, "state", "dipo.db"));
        const mine = join(dir, "dipo-run-run_01MINE");
        prepareRunTempDir(mine, owner);
        writeFileSync(join(mine, "cache"), "x");
        const foreign = join(dir, "dipo-run-run_01FOREIGN");
        prepareRunTempDir(foreign, "another-daemon");
        const unowned = join(dir, "dipo-run-run_01NOOWNER");
        prepareRunTempDir(unowned, undefined);
        const daemon = start(daemonEnv(dir));
        try {
          await waitUntilServing(dir, daemon);
          expect(existsSync(mine)).toBe(false);
          expect(existsSync(foreign)).toBe(true);
          expect(existsSync(unowned)).toBe(true);
          const removed = readFileSync(join(dir, "state", "logs", "daemon.log"), "utf8")
            .trim()
            .split("\n")
            .map((entry) => JSON.parse(entry) as Record<string, unknown>)
            .find((entry) => entry["msg"] === "removed run temp directories of ended runs");
          expect(removed).toMatchObject({ removed: [mine] });
        } finally {
          expect(await stop(daemon)).toBe(0);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "reads <state>/config.yaml at start",
    async () => {
      await withTempDir(async (dir) => {
        const state = join(dir, "state");
        await Bun.write(
          join(state, "config.yaml"),
          "version: 1\ndaemon:\n  autoRestartOnUpgrade: true\n",
        );
        const daemon = start(daemonEnv(dir));
        try {
          await waitUntilServing(dir, daemon);
          const line = readFileSync(join(state, "logs", "daemon.log"), "utf8")
            .trim()
            .split("\n")
            .map((entry) => JSON.parse(entry) as Record<string, unknown>)
            .find((entry) => entry["msg"] === "software configuration");
          expect(line).toMatchObject({
            fromFile: true,
            autostart: true,
            autoRestartOnUpgrade: true,
          });
        } finally {
          expect(await stop(daemon)).toBe(0);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "refuses to start with a config.yaml newer than it knows",
    async () => {
      await withTempDir(async (dir) => {
        const state = join(dir, "state");
        await Bun.write(join(state, "config.yaml"), "version: 2\n");
        const daemon = start(daemonEnv(dir));
        try {
          // EX_CONFIG, so a supervisor does not restart it in a loop.
          expect(await daemon.exited).toBe(78);
          const stderr = await new Response(daemon.stderr).text();
          expect(stderr).toContain(`dipo: ${join(state, "config.yaml")}: version: `);
          expect(stderr).toContain("upgrade dipo");
          // Refused before the lock: nothing to clean up.
          expect(existsSync(join(state, "dipo.pid"))).toBe(false);
        } finally {
          await stop(daemon);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "exits with EX_CONFIG for an invalid config.yaml",
    async () => {
      await withTempDir(async (dir) => {
        const state = join(dir, "state");
        await Bun.write(join(state, "config.yaml"), "version: 1\ndaemon:\n  autostrat: false\n");
        const daemon = start(daemonEnv(dir));
        try {
          expect(await daemon.exited).toBe(78);
          expect(await new Response(daemon.stderr).text()).toContain(
            `dipo: ${join(state, "config.yaml")}: daemon.autostrat: unknown key`,
          );
          expect(existsSync(join(state, "dipo.pid"))).toBe(false);
        } finally {
          await stop(daemon);
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

  it(
    "reports a live daemon as already running through engine.hello, not unresponsive",
    async () => {
      await withTempDir(async (dir) => {
        const env = daemonEnv(dir);
        const daemon = start(env);
        try {
          await waitUntilServing(dir, daemon);
          const second = start(env);
          const started = performance.now();
          expect(await second.exited).toBe(0);
          // Answered on the first handshake, not after the 5 s wait for an unresponsive daemon.
          expect(performance.now() - started).toBeLessThan(4000);
          expect(await new Response(second.stdout).text()).toContain(
            `dipo daemon is already running (pid ${daemon.pid}`,
          );
          expect(await new Response(second.stderr).text()).not.toContain("does not answer");
        } finally {
          expect(await stop(daemon)).toBe(0);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "sends its lifecycle transitions to a subscribed client as daemon.state",
    async () => {
      await withTempDir(async (dir) => {
        const daemon = start(daemonEnv(dir));
        try {
          await waitUntilServing(dir, daemon);
          const client = await TestClient.connect(join(dir, "run", "dipo.sock"));
          const hello = await client.hello();
          if (!hello.ok) throw new Error(hello.error.message);
          const { cursor } = hello.result as { cursor: { seq: number } };
          expect(cursor.seq).toBe(2);
          const subscribed = await client.subscribe("software", { ...cursor, seq: 0 } as never);
          expect(subscribed.ok).toBe(true);
          await client.waitForEvent("software", (e) => e.type === "stream.mark", "catch-up");
          daemon.kill("SIGTERM");
          await client.waitForEvent(
            "software",
            (e) => (e.data as { to?: string }).to === "draining",
            "daemon.state to draining",
          );
          expect((await client.closed).code).toBe(1001);
          const states = client
            .events("software")
            .filter((e) => e.type === "daemon.state")
            .map((e) => e.data as { from: string; to: string; reason: string });
          expect(states).toEqual([
            { from: "starting", to: "recovering", reason: "running recovery steps" },
            { from: "recovering", to: "running", reason: "recovered" },
            { from: "running", to: "draining", reason: "SIGTERM" },
          ]);
          expect(client.invalid).toEqual([]);
          expect(await daemon.exited).toBe(0);
        } finally {
          await stop(daemon);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "stops on daemon.stop after sending its reply and the draining state",
    async () => {
      await withTempDir(async (dir) => {
        const daemon = start(daemonEnv(dir));
        try {
          await waitUntilServing(dir, daemon);
          const client = await TestClient.connect(join(dir, "run", "dipo.sock"));
          expect((await client.hello()).ok).toBe(true);
          expect((await client.subscribe("software")).ok).toBe(true);
          const reply = await client.command("daemon.stop", { stopWorkers: false });
          expect(reply).toMatchObject({ ok: true, result: { state: "draining" }, changed: true });
          await client.waitForEvent(
            "software",
            (e) => e.type === "daemon.state" && (e.data as { to?: string }).to === "draining",
            "daemon.state to draining",
          );
          expect((await client.closed).code).toBe(1001);
          expect(client.invalid).toEqual([]);
          expect(await daemon.exited).toBe(0);
          expect(existsSync(join(dir, "state", "dipo.pid"))).toBe(false);
          expect(existsSync(join(dir, "run", "dipo.sock"))).toBe(false);
        } finally {
          await stop(daemon);
        }
      });
    },
    TIMEOUT_MS,
  );
});
