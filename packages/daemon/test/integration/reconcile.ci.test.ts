// CI only (0017 section 1): a daemon start reconciles every registered office in `recovering`,
// before it enters `running` and scheduling turns on (DIPO-56 test plan, AC #7 and #8). A real
// `dipo daemon --foreground` opens an office, stops, and starts again: the second start loads and
// reconciles the office without any office command, and the log orders reconcile before
// `running`. State, runtime directory and temp files stay under the test's temp directory.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { cleanEnv, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { TestClient } from "../support/client";

const MAIN = resolve(import.meta.dir, "../../../cli/src/main.ts");
const FIXTURE = resolve(import.meta.dir, "../../../engine/test/fixtures/backlog");
const TIMEOUT_MS = 60_000;

type Daemon = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface LogLine {
  readonly msg: string;
  readonly to?: string;
  readonly office?: string;
  readonly trigger?: string;
}

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

function logLines(dir: string): LogLine[] {
  return readFileSync(join(dir, "state", "logs", "daemon.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LogLine);
}

async function waitUntilRunning(dir: string, daemon: Daemon): Promise<void> {
  const deadline = performance.now() + 30_000;
  const socket = join(dir, "run", "dipo.sock");
  while (performance.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`daemon exited with ${daemon.exitCode}`);
    try {
      const client = await TestClient.connect(socket);
      try {
        await client.hello();
        const status = await client.read("daemon.status");
        const result = status.ok ? (status.result as { pid: number; state: string }) : null;
        if (result?.pid === daemon.pid && result.state === "running") return;
      } finally {
        await client.close();
      }
    } catch {
      // Not bound yet.
    }
    await Bun.sleep(50);
  }
  throw new Error("daemon did not reach running within 30 s");
}

async function stop(daemon: Daemon): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  daemon.kill("SIGTERM");
  const exited = await Promise.race([daemon.exited, Bun.sleep(10_000).then(() => "timeout")]);
  if (exited === "timeout") {
    daemon.kill("SIGKILL");
    await daemon.exited;
  }
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("reconcile at daemon start", () => {
    it(
      "loads and reconciles every registered office in recovering, before running",
      () =>
        withBareRemote(
          async (repo) => {
            await repo.commitAll("fixture");
            await repo.git("push", "--quiet", "-u", "origin", "main");
            await repo.git("remote", "set-head", "origin", "main");
            const dir = repo.root;
            const env = daemonEnv(dir);

            const first = start(env);
            let office = "";
            try {
              await waitUntilRunning(dir, first);
              const client = await TestClient.connect(join(dir, "run", "dipo.sock"));
              try {
                await client.hello();
                const reply = await client.command("office.open", { path: repo.dir });
                if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
                office = (reply.result as { office: string }).office;
              } finally {
                await client.close();
              }
            } finally {
              await stop(first);
            }
            const before = logLines(dir).length;

            const second = start(env);
            try {
              await waitUntilRunning(dir, second);
              const lines = logLines(dir).slice(before);
              const reconciled = lines.findIndex(
                (line) =>
                  (line.msg === "office reconciled" || line.msg === "reconcile failed") &&
                  line.office === office,
              );
              const running = lines.findIndex(
                (line) => line.msg === "daemon state" && line.to === "running",
              );
              expect(reconciled).toBeGreaterThanOrEqual(0);
              expect(lines[reconciled]?.trigger).toBe("start");
              expect(running).toBeGreaterThan(reconciled);
              expect(
                lines.some((line) => line.msg === "office loaded" && line.office === office),
              ).toBe(true);
            } finally {
              await stop(second);
            }
          },
          { fixture: FIXTURE },
        ),
      TIMEOUT_MS,
    );
  });
}
