// The client against a real `dipo daemon --foreground` in a temp DIPO_HOME (DIPO-25 test plan):
// hello, a command, a dropped connection, reconnect and re-subscribe without duplicates, a client
// of another version refused (0005), and the `dipo daemon log-level` and `resume-scheduling`
// subcommands as real processes. State, runtime directory and temp files stay under the test's temp
// directory (DIPO_HOME, DIPO_RUNTIME_DIR, DIPO_TMP), and the daemon is stopped in a `finally`.

import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  daemonResumeScheduling,
  daemonSetLogLevel,
  daemonStatus,
  type Event,
  type StreamName,
} from "@dipsaus-orchestrator/contract";
import { daemonTestEnv, withDaemonTempDir } from "@dipsaus-orchestrator/testkit";

import { type ConnectionState, DipoClient, type Transport } from "../../src/index";
import {
  connectToDaemon,
  DaemonNotRunningError,
  OtherVersionError,
  readRuntimeInfo,
  systemClock,
  unixSocketTransport,
} from "../../src/node/index";

const MAIN = resolve(import.meta.dir, "../../../cli/src/main.ts");
const TIMEOUT_MS = 30_000;
const SOFTWARE = "software" as StreamName;
// The daemon runs from source, so its version is `dev` (cli/src/version.ts); a client must match.
const CLIENT = { name: "client-test", version: "dev" };

type Daemon = Bun.Subprocess<"ignore", "pipe", "pipe">;

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
    "says hello, sends a command, reconnects and re-subscribes after its cursor without duplicates",
    async () => {
      await withDaemonTempDir(async (dir) => {
        const env = daemonTestEnv(dir);
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
          expect(hello.daemon).toBe("running");
          expect(hello.engine).toBe(CLIENT.version);

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

          // The connection drops; meanwhile another client connects, and this client sends a
          // command that waits for the next connection.
          link.drop();
          expect(client.state).toBe("reconnecting");
          const pending = client.command(daemonSetLogLevel, { level: "info" });
          const { client: other } = await connectToDaemon({ client: CLIENT, origin: "other", env });
          clients.push(other);
          const resumed = await other.command(daemonResumeScheduling, {});
          // Nothing is paused: the command changes nothing (0005).
          expect(resumed).toMatchObject({ ok: true, result: { state: "running" }, changed: false });

          // Reconnect after 0.5 s: hello again, re-subscribe after the last cursor, re-send.
          expect(await pending).toMatchObject({ ok: true, result: { level: "info" } });
          expect(client.hello?.daemon).toBe("running");
          await until(() => caughtUp === 2, "the catch-up after the reconnect");
          expect(events.filter((event) => event.type === "daemon.state")).toEqual([]);

          // A second drop with nothing new replays nothing and duplicates nothing.
          const cursor = subscription.cursor;
          link.drop();
          await until(() => caughtUp === 3, "the catch-up after the second reconnect");
          expect(subscription.cursor).toEqual(cursor);
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
      await withDaemonTempDir(async (dir) => {
        const env = daemonTestEnv(dir);
        const daemon = await startDaemon(env);
        try {
          const set = await runCli(["daemon", "log-level", "debug"], env);
          expect(set).toMatchObject({
            code: 0,
            stdout: "daemon log level: debug (until the daemon restarts)\n",
          });

          const resume = await runCli(["daemon", "resume-scheduling"], env);
          expect(resume).toMatchObject({
            code: 0,
            stdout: "starts unpaused in every office; daemon state: running\n",
          });

          // A client of another version is refused with the restart hint (0005).
          const other = connectToDaemon({
            client: { ...CLIENT, version: "0" },
            origin: "other",
            env,
          });
          await expect(other).rejects.toBeInstanceOf(OtherVersionError);
          await expect(other).rejects.toMatchObject({
            daemonVersion: "dev",
            message: "daemon runs vdev, this binary is v0, run `dipo daemon restart`",
          });

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
