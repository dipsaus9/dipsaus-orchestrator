// CI only (0017 section 1; DIPO-316 AC #5): a real daemon process is killed with SIGKILL during a
// live run and started again, and the run re-attaches and ends once. The daemon is `dipo daemon
// --foreground` with a scripted worker port (`fixtures/scripted-worker-daemon.ts`): `work.run`
// claims TASK-1 of the Backlog fixture on real git with a bare `origin` and starts a real detached
// worker host whose worker is a script. After the SIGKILL the host and the worker go on; the next
// daemon re-attaches to the host by PID, start time and handshake, catches up on the lines written
// while no daemon ran, and `work.stop` ends the run through the re-attached host. One host, one
// agent, one end. State, runtime and temp files stay under the test's temp directory, the daemon's
// PATH holds no `claude`, `gh` or `container`, and every process is stopped in a `finally`.

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  assertTestRuntimeDir,
  daemonTestEnv,
  type TempRepoWithRemote,
  withBareRemote,
} from "@dipsaus-orchestrator/testkit";

import { TestClient } from "../support/client";

const DAEMON = resolve(import.meta.dir, "fixtures/scripted-worker-daemon.ts");
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const BACKLOG_FIXTURE = join(REPO_ROOT, "packages/engine/test/fixtures/backlog");
const BACKLOG_JS = join(REPO_ROOT, "node_modules", "backlog.md", "cli.js");
/**
 * The one budget every wait of this test is derived from: a daemon start, a reply, or one step of
 * the run. Generous, because this test runs only in CI, where the macOS runner is much slower than
 * a developer machine.
 */
const BUDGET_MS = 30_000;
/** Two daemon starts, three commands, five run steps and two stops, each within the budget. */
const TIMEOUT_MS = 14 * BUDGET_MS;

type Daemon = Bun.Subprocess<"ignore", "ignore", "pipe">;

interface LogLine {
  readonly msg: string;
  readonly to?: string;
  readonly run?: string;
  readonly outcome?: string;
}

/**
 * A PATH with only what the daemon needs: Bun as `node` (the Backlog CLI's launcher), the pinned
 * Backlog CLI, a `claude` stand-in that only fails (the worker port needs a path; the scripted plan
 * never runs it), and the system directories for git and the shell. No `claude`, `gh` or
 * `container` of the machine's own can be reached from it.
 */
function testPath(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(process.execPath, join(bin, "bun"));
  symlinkSync(BACKLOG_JS, join(bin, "backlog"));
  writeFileSync(join(bin, "claude"), CLAUDE_STAND_IN, { mode: 0o755 });
  return [bin, "/usr/bin", "/bin"].join(":");
}

const CLAUDE_STAND_IN = '#!/bin/sh\necho "the test daemon never runs claude" >&2\nexit 97\n';

async function backlog(repo: TempRepoWithRemote, args: string[]): Promise<void> {
  const result = await repo.run([process.execPath, BACKLOG_JS, ...args], repo.dir);
  if (result.exitCode !== 0) {
    throw new Error(`backlog ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  }
}

/** The fixture on `origin` with TASK-1 made to pass the Ready gate. */
async function readyFixture(repo: TempRepoWithRemote): Promise<void> {
  mkdirSync(join(repo.dir, "backlog", "archive", "tasks"), { recursive: true });
  // A run needs a resolved verify (DIPO-72); the box run's verify is CI, so any script will do.
  writeFileSync(
    join(repo.dir, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, scripts: { verify: "true" } })}\n`,
  );
  await repo.commitAll("fixture");
  await repo.git("push", "--quiet", "-u", "origin", "main");
  await repo.git("remote", "set-head", "origin", "main");
  await backlog(repo, ["milestone", "add", "M0 Walking skeleton"]);
  await backlog(repo, [
    "task",
    "edit",
    "TASK-1",
    "--type",
    "feature",
    "-m",
    "m-0",
    "--ref",
    "packages/export/",
  ]);
  await repo.commitAll("make TASK-1 pass the gate");
  await repo.git("push", "--quiet", "origin", "main");
}

function start(env: Record<string, string>): Daemon {
  return Bun.spawn({
    cmd: [process.execPath, DAEMON],
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
}

function logLines(dir: string): LogLine[] {
  const path = join(dir, "state", "logs", "daemon.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as LogLine);
}

/** The last lines of the daemon log, for a failure message. */
function logTail(dir: string, lines = 40): string {
  const path = join(dir, "state", "logs", "daemon.log");
  if (!existsSync(path)) return "(no daemon.log yet)";
  return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

/** `error` with the daemon log's tail appended, so a CI failure says what the daemon did. */
function withLog(dir: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}\n--- the last lines of daemon.log ---\n${logTail(dir)}`);
}

async function waitFor<T>(
  dir: string,
  what: string,
  read: () => T | null | Promise<T | null>,
  ms = BUDGET_MS,
): Promise<T> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  throw withLog(dir, new Error(`timed out after ${ms} ms waiting for ${what}`));
}

/** Waits until the daemon's socket answers the handshake and `daemon.status` says `running`. */
async function waitUntilRunning(dir: string, daemon: Daemon): Promise<void> {
  const socket = join(dir, "run", "dipo.sock");
  await waitFor(dir, "the daemon to reach running", async () => {
    // A daemon that chose a runtime directory outside `dir` fails the test (DIPO-109).
    assertTestRuntimeDir(dir);
    if (daemon.exitCode !== null) {
      throw withLog(
        dir,
        `daemon exited with ${daemon.exitCode}: ${await new Response(daemon.stderr).text()}`,
      );
    }
    if (!existsSync(socket)) return null;
    try {
      // One attempt; a daemon still starting is asked again until the budget is spent.
      const client = await TestClient.connect(socket);
      try {
        await client.hello();
        const status = await client.read("daemon.status");
        const result = status.ok ? (status.result as { pid: number; state: string }) : null;
        return result?.pid === daemon.pid && result.state === "running" ? true : null;
      } finally {
        await client.close();
      }
    } catch {
      return null;
    }
  });
}

/** Sends one command to a daemon that `waitUntilRunning` saw ready; its reply gets the budget. */
async function command(
  dir: string,
  name: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    const client = await TestClient.connect(join(dir, "run", "dipo.sock"), BUDGET_MS);
    try {
      await client.hello();
      const reply = await client.command(name, args, extra);
      if (!reply.ok) throw new Error(`${name}: ${reply.error.code}: ${reply.error.message}`);
      return reply.result;
    } finally {
      await client.close();
    }
  } catch (error) {
    throw withLog(dir, error instanceof Error ? new Error(`${name}: ${error.message}`) : error);
  }
}

async function stop(daemon: Daemon): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  daemon.kill("SIGTERM");
  const exited = await Promise.race([daemon.exited, Bun.sleep(BUDGET_MS).then(() => "timeout")]);
  if (exited === "timeout") {
    daemon.kill("SIGKILL");
    await daemon.exited;
  }
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

interface HostRow {
  agent_id: string;
  pid: number;
  pending: number;
  processed_offset: number;
  final_offset: number | null;
  ended_at: number | null;
  event_file: string;
  mode: string;
}

/** Reads the state database next to the daemon (WAL: a reader never blocks it). */
function query<T>(dir: string, sql: string, params: Record<string, string> = {}): T[] {
  const db = new Database(join(dir, "state", "dipo.db"));
  try {
    return db.query(sql).all(params) as T[];
  } finally {
    db.close();
  }
}

const hostsOf = (dir: string, run: string) =>
  query<HostRow>(
    dir,
    `select agent_id, pid, pending, processed_offset, final_offset, ended_at, event_file, mode
       from worker_hosts where run_id = $run order by started_at`,
    { $run: run },
  );

const fileSize = (path: string) => (existsSync(path) ? statSync(path).size : 0);

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("a daemon killed with SIGKILL during a run", () => {
    it(
      "re-attaches to the living worker host after the restart, and the run ends once",
      () =>
        withBareRemote(
          async (repo) => {
            await readyFixture(repo);
            const dir = repo.root;
            const env = { ...daemonTestEnv(dir, repo.env), PATH: testPath(dir) };
            let first: Daemon | null = start(env);
            let second: Daemon | null = null;
            try {
              await waitUntilRunning(dir, first);
              const { office } = (await command(dir, "office.open", { path: repo.dir })) as {
                office: string;
              };
              const started = (await command(
                dir,
                "work.run",
                { stories: ["TASK-1"] },
                { office, confirmed: true },
              )) as { started: { run: string }[]; skipped: unknown[] };
              expect(started.skipped).toEqual([]);
              const run = started.started[0]?.run ?? "";
              expect(run).not.toBe("");

              // The first daemon follows the live host.
              const live = await waitFor(dir, "the first daemon to follow the host", () => {
                const host = hostsOf(dir, run)[0];
                return host !== undefined && host.pending === 0 && host.processed_offset > 0
                  ? host
                  : null;
              });

              first.kill("SIGKILL");
              await first.exited;
              first = null;
              // The host and its worker go on writing while no daemon runs.
              const down = hostsOf(dir, run)[0]?.processed_offset ?? 0;
              await waitFor(dir, "lines written while no daemon runs", () =>
                fileSize(live.event_file) > down + 200 ? true : null,
              );

              const before = logLines(dir).length;
              second = start(env);
              await waitUntilRunning(dir, second);
              const reattached = logLines(dir)
                .slice(before)
                .filter((line) => line.msg === "worker host re-attached" && line.run === run);
              expect(reattached.map((line) => line.outcome)).toEqual(["steer"]);
              await waitFor(dir, "the second daemon to catch up", () => {
                const host = hostsOf(dir, run)[0];
                return host !== undefined && host.processed_offset > down ? true : null;
              });

              await command(dir, "work.stop", { story: "TASK-1" }, { office, confirmed: true });
              const exitFile = join(dirname(live.event_file), "exit.json");
              await waitFor(dir, "the run and its worker to end", () => {
                const ended = query<{ n: number }>(
                  dir,
                  `select count(*) as n from runs r join agents a on a.run_id = r.run_id
                    where r.run_id = $run and r.ended_at is not null and a.ended_at is not null`,
                  { $run: run },
                );
                return ended[0]?.n === 1 && existsSync(exitFile) ? true : null;
              });
              await stop(second);
              second = null;

              // One host, followed by both daemons: never a second start, and its event file
              // processed to the end, where the host's exit says it ends.
              const hosts = hostsOf(dir, run);
              expect(hosts).toHaveLength(1);
              const host = hosts[0] as HostRow;
              expect(host.pid).toBe(live.pid);
              const exit = JSON.parse(readFileSync(exitFile, "utf8")) as { finalOffset: number };
              expect(exit.finalOffset).toBe(fileSize(host.event_file));
              expect(host.processed_offset).toBe(exit.finalOffset);
              // One agent, ended once; one run, ended once.
              const agents = query<{ ended_at: number | null }>(
                dir,
                "select ended_at from agents where run_id = $run",
                { $run: run },
              );
              expect(agents).toHaveLength(1);
              expect(agents[0]?.ended_at).not.toBeNull();
              const runs = query<{ ended_at: number | null }>(
                dir,
                "select ended_at from runs where run_id = $run",
                { $run: run },
              );
              expect(runs).toHaveLength(1);
              const output = query<{ text: string }>(
                dir,
                "select text from output_chunks where run_id = $run order by from_offset",
                { $run: run },
              )
                .map((row) => row.text)
                .join("");
              expect(output.match(/\[dipo\] \S+ ended /g)).toHaveLength(1);
              // The stop through the re-attached host parked the story once.
              const parks = query<{ reason: string }>(
                dir,
                "select reason from parks where run_id = $run",
                { $run: run },
              );
              expect(parks).toEqual([{ reason: "stopped" }]);
            } finally {
              if (first !== null) await stop(first);
              if (second !== null) await stop(second);
              // Every worker host the daemons started, whatever the test reached.
              if (existsSync(join(dir, "state", "dipo.db"))) {
                for (const { pid } of query<{ pid: number }>(dir, "select pid from worker_hosts")) {
                  killGroup(pid);
                }
              }
            }
          },
          { fixture: BACKLOG_FIXTURE },
        ),
      TIMEOUT_MS,
    );
  });
}
