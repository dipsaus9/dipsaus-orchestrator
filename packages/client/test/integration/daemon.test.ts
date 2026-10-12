// The client against a real `dipo daemon --foreground` in a temp DIPO_HOME (DIPO-25 test plan):
// hello, a command, a dropped connection, reconnect and replay without duplicates, and the
// `dipo daemon log-level` and `resume-scheduling` subcommands as real processes. The daemon starts
// in `safe` (a seeded crash loop), so `daemon.resumeScheduling` puts a `daemon.state` event on the
// software stream while the first client is away. State, runtime directory and temp files stay
// under the test's temp directory (DIPO_HOME, DIPO_RUNTIME_DIR, DIPO_TMP), and the daemon is
// stopped in a `finally`.

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  daemonResumeScheduling,
  daemonSetLogLevel,
  daemonStatus,
  type Event,
  type StreamName,
} from "@dipsaus-orchestrator/contract";
import { cleanEnv, withTempDir } from "@dipsaus-orchestrator/testkit";

import { type ConnectionState, DipoClient, type Transport } from "../../src/index";
import {
  connectToDaemon,
  DaemonNotRunningError,
  readRuntimeInfo,
  systemClock,
  unixSocketTransport,
} from "../../src/node/index";

const MAIN = resolve(import.meta.dir, "../../../cli/src/main.ts");
const TIMEOUT_MS = 30_000;
const SOFTWARE = "software" as StreamName;
const CLIENT = { name: "client-test", version: "0" };

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

/** Two recent crashes and a marker left by a dead daemon: the next start is the third, so `safe`. */
function seedCrashLoop(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const now = systemClock.now();
  writeFileSync(
    join(stateDir, "crashes.json"),
    `${JSON.stringify({
      version: 1,
      running: { pid: 999_999, startTimeMs: 1 },
      crashes: [now - 120_000, now - 60_000],
    })}\n`,
  );
}

async function startDaemon(env: Record<string, string>): Promise<Daemon> {
  const daemon = Bun.spawn({
    cmd: [process.execPath, MAIN, "daemon", "--foreground"],
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`daemon exited with ${daemon.exitCode}`);
    try {
      const { client } = await connectToDaemon({ client: CLIENT, origin: "other", env });
      try {
        const status = await client.read(daemonStatus, {});
        if (status.ok && status.result.pid === daemon.pid && status.result.state !== "recovering") {
          return daemon;
        }
      } finally {
        client.close();
      }
    } catch {
      // Not serving yet.
    }
    await Bun.sleep(50);
  }
  throw new Error("daemon did not start serving within 10 s");
}

async function stopDaemon(daemon: Daemon): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  daemon.kill("SIGTERM");
  const exited = await Promise.race([daemon.exited, Bun.sleep(5000).then(() => "timeout")]);
  if (exited === "timeout") {
    daemon.kill("SIGKILL");
    await daemon.exited;
  }
}

/** The Unix transport, with a way for the test to drop the live connection as a network loss would. */
function droppable(socket: string): { transport: Transport; drop: () => void } {
  const inner = unixSocketTransport(socket);
  let live: { close(): void } | null = null;
  return {
    transport: {
      connect(handlers) {
        const connection = inner.connect(handlers);
        live = connection;
        return connection;
      },
    },
    drop: () => live?.close(),
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

async function runCli(args: string[], env: Record<string, string>) {
  const child = Bun.spawn({
    cmd: [process.execPath, MAIN, ...args],
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

describe("client against a running daemon", () => {
  it(
    "says hello, sends a command, reconnects and replays what it missed without duplicates",
    async () => {
      await withTempDir(async (dir) => {
        const env = daemonEnv(dir);
        seedCrashLoop(env["DIPO_HOME"] ?? "");
        const daemon = await startDaemon(env);
        const clients: DipoClient[] = [];
        try {
          const runtime = readRuntimeInfo(env["DIPO_HOME"] ?? "");
          if (runtime === null) throw new Error("no runtime.json");
          expect(runtime.pid).toBe(daemon.pid);

          const link = droppable(runtime.socket);
          const client = new DipoClient({
            transport: link.transport,
            clock: systemClock,
            client: CLIENT,
            origin: "other",
          });
          clients.push(client);
          const states: ConnectionState[] = [];
          client.onState((state) => states.push(state));
          const hello = await client.connect();
          expect(hello.daemon).toBe("safe");

          const events: Event[] = [];
          let caughtUp = 0;
          const subscription = client.subscribe(SOFTWARE, {
            after: hello.cursor,
            onEvent: (event) => events.push(event),
            onCaughtUp: () => (caughtUp += 1),
          });
          await until(() => caughtUp === 1, "the first catch-up");

          const level = await client.command(daemonSetLogLevel, { level: "debug" });
          expect(level).toMatchObject({ ok: true, result: { level: "debug" }, changed: true });

          // The connection drops; meanwhile another client resumes scheduling, and this client
          // sends a command that waits for the next connection.
          link.drop();
          expect(client.state).toBe("reconnecting");
          const pending = client.command(daemonSetLogLevel, { level: "info" });
          const { client: other } = await connectToDaemon({ client: CLIENT, origin: "other", env });
          clients.push(other);
          const resumed = await other.command(daemonResumeScheduling, {});
          expect(resumed).toMatchObject({ ok: true, result: { state: "running" } });

          // Reconnect after 0.5 s: hello again, re-subscribe after the last cursor, re-send.
          expect(await pending).toMatchObject({ ok: true, result: { level: "info" } });
          expect(client.hello?.daemon).toBe("running");
          await until(() => caughtUp === 2, "the catch-up after the reconnect");
          const changes = events.filter((event) => event.type === "daemon.state");
          expect(changes.map((event) => event.data)).toEqual([
            { from: "safe", to: "running", reason: "scheduling resumed" },
          ]);

          // A second drop with nothing new replays nothing and duplicates nothing.
          const cursor = subscription.cursor;
          link.drop();
          await until(() => caughtUp === 3, "the catch-up after the second reconnect");
          expect(subscription.cursor).toEqual(cursor);
          expect(events.filter((event) => event.type === "daemon.state")).toHaveLength(1);
          const stored = events.filter((event) => event.type !== "stream.mark");
          const seqs = stored.map((event) => event.cursor.seq);
          expect(new Set(seqs).size).toBe(seqs.length);
          expect(states.filter((state) => state === "reconnecting")).toHaveLength(2);
          expect(states.at(-1)).toBe("open");
        } finally {
          for (const client of clients) client.close();
          await stopDaemon(daemon);
        }
      });
    },
    TIMEOUT_MS,
  );

  it(
    "runs dipo daemon log-level and resume-scheduling, and names dipo daemon start once it is gone with autostart off",
    async () => {
      await withTempDir(async (dir) => {
        const env = daemonEnv(dir);
        const daemon = await startDaemon(env);
        try {
          const set = await runCli(["daemon", "log-level", "debug"], env);
          expect(set).toMatchObject({
            code: 0,
            stdout: "daemon log level: debug (until the daemon restarts)\n",
          });

          const resume = await runCli(["daemon", "resume-scheduling"], env);
          expect(resume.code).toBe(1);
          expect(resume.stderr).toStartWith("dipo: daemon.notSafe: ");

          await stopDaemon(daemon);
          const log = readFileSync(join(env["DIPO_HOME"] ?? "", "logs", "daemon.log"), "utf8");
          expect(log).toContain('"level":"debug"');

          // With autostart off (DIPO-70) a command that needs the daemon names `dipo daemon start`
          // and starts nothing.
          writeFileSync(
            join(env["DIPO_HOME"] ?? "", "config.yaml"),
            "version: 1\ndaemon:\n  autostart: false\n",
          );
          for (const args of [
            ["daemon", "log-level", "info"],
            ["daemon", "resume-scheduling"],
          ]) {
            const gone = await runCli(args, env);
            expect(gone.code).not.toBe(0);
            expect(gone.stderr).toContain("dipo daemon start");
          }
          await expect(
            connectToDaemon({ client: CLIENT, origin: "other", env }),
          ).rejects.toBeInstanceOf(DaemonNotRunningError);
        } finally {
          await stopDaemon(daemon);
        }
      });
    },
    TIMEOUT_MS,
  );
});
