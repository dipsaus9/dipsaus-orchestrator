// CI only (0017 section 1): `dipo restore` and missing office paths against a real
// `dipo daemon --foreground` (DIPO-76 test plan). Restore refuses while the daemon runs and names
// `dipo daemon stop`; with the daemon stopped it replaces a damaged `dipo.db` from a backup and
// removes the stale `-wal` and `-shm`, a client that reconnects with its old cursor gets
// `stream.resetRequired`, and the next start reconciles the office. An office whose path is gone
// is listed at start with the "path missing" notice. State, runtime directory and temp files stay
// under the test's temp directory.

import { describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Cursor } from "@dipsaus-orchestrator/contract";
import { assertTestRuntimeDir, daemonTestEnv, withBareRemote } from "@dipsaus-orchestrator/testkit";

import { TestClient } from "../support/client";

const MAIN = resolve(import.meta.dir, "../../../cli/src/main.ts");
const FIXTURE = resolve(import.meta.dir, "../../../engine/test/fixtures/backlog");
const TIMEOUT_MS = 90_000;

type Daemon = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface LogLine {
  readonly msg: string;
  readonly to?: string;
  readonly office?: string;
  readonly trigger?: string;
  readonly reason?: string;
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

async function dipo(
  env: Record<string, string>,
  args: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, MAIN, ...args],
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
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
    // A daemon that chose a runtime directory outside `dir` fails the test (DIPO-109).
    assertTestRuntimeDir(dir);
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

/** Starts a daemon, opens the repository as an office, subscribes to it, and stops the daemon. */
async function openOnce(
  dir: string,
  env: Record<string, string>,
  path: string,
): Promise<{ office: string; cursor: Cursor }> {
  const daemon = start(env);
  try {
    await waitUntilRunning(dir, daemon);
    const client = await TestClient.connect(join(dir, "run", "dipo.sock"));
    try {
      await client.hello();
      const reply = await client.command("office.open", { path });
      if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
      const office = (reply.result as { office: string }).office;
      const subscribed = await client.subscribe(`office:${office}`);
      if (!subscribed.ok) throw new Error(`${subscribed.error.code}: ${subscribed.error.message}`);
      return { office, cursor: (subscribed.result as { from: Cursor }).from };
    } finally {
      await client.close();
    }
  } finally {
    await stop(daemon);
  }
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("dipo restore with a real daemon", () => {
    it(
      "refuses while the daemon runs, restores a damaged file, and resets old cursors",
      () =>
        withBareRemote(
          async (repo) => {
            await repo.commitAll("fixture");
            await repo.git("push", "--quiet", "-u", "origin", "main");
            await repo.git("remote", "set-head", "origin", "main");
            const dir = repo.root;
            const env = daemonTestEnv(dir);
            const { office, cursor } = await openOnce(dir, env, repo.dir);

            // The daemon stopped cleanly, so dipo.db alone is a consistent copy.
            const live = join(dir, "state", "dipo.db");
            const backup = join(dir, "backup.db");
            copyFileSync(live, backup);

            const running = start(env);
            try {
              await waitUntilRunning(dir, running);
              const refused = await dipo(env, ["restore", backup]);
              expect(refused.code).toBe(1);
              expect(refused.err).toContain("`dipo daemon stop`");
            } finally {
              await stop(running);
            }

            writeFileSync(live, "damaged beyond repair");
            writeFileSync(`${live}-wal`, "stale wal");
            writeFileSync(`${live}-shm`, "stale shm");
            const restored = await dipo(env, ["restore", backup]);
            expect(restored.err).toBe("");
            expect(restored.code).toBe(0);
            expect(restored.out).toContain(`restored ${backup} into ${live}`);
            expect(existsSync(`${live}-wal`)).toBe(false);
            expect(existsSync(`${live}-shm`)).toBe(false);

            const before = logLines(dir).length;
            const again = start(env);
            try {
              await waitUntilRunning(dir, again);
              const client = await TestClient.connect(join(dir, "run", "dipo.sock"));
              try {
                await client.hello();
                const reply = await client.subscribe(`office:${office}`, cursor);
                expect(reply.ok).toBe(false);
                if (!reply.ok) expect(reply.error.code).toBe("stream.resetRequired");
              } finally {
                await client.close();
              }
              const lines = logLines(dir).slice(before);
              expect(
                lines.some(
                  (line) =>
                    (line.msg === "office reconciled" || line.msg === "reconcile failed") &&
                    line.office === office &&
                    line.trigger === "start",
                ),
              ).toBe(true);
            } finally {
              await stop(again);
            }
          },
          { fixture: FIXTURE },
        ),
      TIMEOUT_MS,
    );

    it(
      "lists an office whose path is missing at start with the path-missing notice",
      () =>
        withBareRemote(
          async (repo) => {
            await repo.commitAll("fixture");
            const dir = repo.root;
            const env = daemonTestEnv(dir);
            const { office } = await openOnce(dir, env, repo.dir);
            renameSync(repo.dir, join(dir, "moved"));

            const before = logLines(dir).length;
            const daemon = start(env);
            try {
              await waitUntilRunning(dir, daemon);
              const notice = logLines(dir)
                .slice(before)
                .find(
                  (line) => line.msg === "office not loaded at start" && line.office === office,
                );
              expect(notice?.reason).toContain(
                "path missing; `dipo office open` the new path, or `dipo office purge`",
              );
            } finally {
              await stop(daemon);
              renameSync(join(dir, "moved"), repo.dir);
            }
          },
          { fixture: FIXTURE },
        ),
      TIMEOUT_MS,
    );
  });
}
