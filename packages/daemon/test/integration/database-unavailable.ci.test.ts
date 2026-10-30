// CI only (0017 section 1, DIPO-225): real git repositories and processes, too slow for the local
// run.
// A state database the daemon cannot open or migrate (DIPO-111, 0005, 0007), against real
// `dipo daemon --foreground` processes: the daemon stays up in `recovering` and serves
// `engine.hello`, `daemon.status`, `daemon.setLogLevel` and `daemon.stop`, refuses office commands
// and reads with the non-retryable `database.unavailable`, and its notice and `daemon.status` say
// what to do. A file SQLite finds damaged at open is reported the same way.
// From the kept-up state, `daemon.stop` (what `dipo daemon stop` sends without a supervisor) and
// then copying the named pre-migration backup over `dipo.db` by hand (0007) bring it back. State, runtime directory and temp files
// stay under the test's temp directory, and every daemon is stopped in a `finally`.

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  assertTestRuntimeDir,
  daemonTestEnv,
  withDaemonTempDir,
} from "@dipsaus-orchestrator/testkit";

import { TestClient } from "../support/client";
import { migratedDatabase } from "../support/state-database";

const MAIN = resolve(import.meta.dir, "../../../cli/src/main.ts");
const FAILING = resolve(import.meta.dir, "fixtures/failing-migration-daemon.ts");
const TIMEOUT_MS = 30_000;

type Daemon = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface Status {
  readonly pid: number;
  readonly state: string;
  readonly stateReason?: string;
}

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: { readonly reason?: string; readonly backup?: string };
}

function spawnDaemon(cmd: readonly string[], env: Record<string, string>): Daemon {
  return Bun.spawn({ cmd: [...cmd], env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

const start = (env: Record<string, string>) =>
  spawnDaemon([process.execPath, MAIN, "daemon", "--foreground"], env);
/** The daemon with one more migration that fails (fixtures/failing-migration-daemon.ts). */
const startFailing = (env: Record<string, string>) => spawnDaemon([process.execPath, FAILING], env);

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

const socketOf = (dir: string) => join(dir, "run", "dipo.sock");

/** Waits until `daemon.status` of this daemon matches; returns that status. */
async function waitForStatus(
  dir: string,
  daemon: Daemon,
  match: (status: Status) => boolean,
): Promise<Status> {
  const deadline = performance.now() + 10_000;
  let last: Status | null = null;
  while (performance.now() < deadline) {
    // A daemon that chose a runtime directory outside `dir` fails the test (DIPO-109).
    assertTestRuntimeDir(dir);
    if (daemon.exitCode !== null) throw new Error(`daemon exited with ${daemon.exitCode}`);
    try {
      const client = await TestClient.connect(socketOf(dir));
      try {
        await client.hello();
        const reply = await client.read("daemon.status");
        if (reply.ok) {
          last = reply.result as Status;
          if (last.pid === daemon.pid && match(last)) return last;
        }
      } finally {
        await client.close();
      }
    } catch {
      // Not bound yet.
    }
    await Bun.sleep(50);
  }
  throw new Error(`daemon status did not match within 10 s; last ${JSON.stringify(last)}`);
}

const held = (status: Status) =>
  status.state === "recovering" && (status.stateReason ?? "").includes("No office is loaded.");
const running = (status: Status) => status.state === "running";

async function kill(daemon: Daemon): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  daemon.kill("SIGTERM");
  const exited = await Promise.race([daemon.exited, Bun.sleep(5000).then(() => "timeout")]);
  if (exited === "timeout") {
    daemon.kill("SIGKILL");
    await daemon.exited;
  }
}

/** `daemon.stop` over the socket, as `dipo daemon stop` sends it when no supervisor is installed. */
async function stopOverSocket(dir: string, daemon: Daemon): Promise<number> {
  const client = await TestClient.connect(socketOf(dir));
  try {
    expect((await client.hello()).ok).toBe(true);
    const reply = await client.command("daemon.stop", { stopWorkers: false });
    expect(reply).toMatchObject({ ok: true, result: { state: "draining" } });
  } finally {
    await client.close();
  }
  return daemon.exited;
}

/**
 * Migrates `<state>/dipo.db` to this binary's head, lets `change` alter it, and closes it cleanly
 * (no `-wal` or `-shm`); returns its path.
 */
async function headDatabase(
  dir: string,
  change: (exec: (sql: string) => void) => void = () => {},
): Promise<string> {
  const path = await migratedDatabase(join(dir, "state"), dir);
  const database = new Database(path);
  try {
    change((sql) => database.exec(sql));
  } finally {
    database.close();
  }
  return path;
}

/** The refusal of one office command and one read, which must be the same error. */
async function refusals(dir: string): Promise<Refusal> {
  const client = await TestClient.connect(socketOf(dir));
  try {
    const hello = await client.hello();
    expect(hello).toMatchObject({ ok: true, result: { daemon: "recovering", offices: [] } });
    const opened = await client.command("office.open", { path: dir });
    const read = await client.read("office.snapshot", {});
    const resume = await client.command("daemon.resumeScheduling", {});
    if (opened.ok || read.ok || resume.ok) throw new Error("expected refusals");
    expect(read.error).toEqual(opened.error);
    expect(resume.error.code).toBe("database.unavailable");
    expect(client.invalid).toEqual([]);
    return opened.error as Refusal;
  } finally {
    await client.close();
  }
}

/**
 * Overwrites the 100-byte header of `path` with 0xff after folding the write-ahead log into the
 * file, so SQLite finds no database there at the next open.
 */
function damageHeader(path: string): void {
  const db = new Database(path, { readwrite: true, strict: true });
  try {
    db.run("pragma wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.alloc(100, 0xff), 0, 100, 0);
  } finally {
    closeSync(fd);
  }
}

/** Recovery by hand (0007): the backup copied over `dipo.db`, its sidecars gone. */
function restoreByHand(dir: string, backup: string): void {
  const db = join(dir, "state", "dipo.db");
  for (const suffix of ["-wal", "-shm"]) rmSync(`${db}${suffix}`, { force: true });
  copyFileSync(backup, db);
}

if (process.env["DIPO_TEST_CI"] === "1") {
  describe("dipo daemon --foreground with an unavailable state database", () => {
    it(
      "stays up for a too-new database, serves software commands and says to upgrade dipo",
      async () => {
        await withDaemonTempDir(async (dir) => {
          const env = daemonTestEnv(dir);
          await headDatabase(dir, (exec) => exec("pragma user_version = 9999"));

          const daemon = start(env);
          try {
            const status = await waitForStatus(dir, daemon, held);
            expect(status.stateReason).toContain("schema version 9999");
            expect(status.stateReason).toContain("Upgrade dipo, then run `dipo daemon restart`.");

            const refused = await refusals(dir);
            expect(refused).toMatchObject({
              code: "database.unavailable",
              retryable: false,
              message: status.stateReason,
              details: { reason: "tooNew" },
            });

            const client = await TestClient.connect(socketOf(dir));
            try {
              const hello = await client.hello();
              if (!hello.ok) throw new Error(hello.error.message);
              const { cursor } = hello.result as { cursor: { seq: number } };
              // The stream's seqs start at the daemon's start time: subscribe from its oldest.
              const reset = await client.subscribe("software", { ...cursor, seq: 0 } as never);
              const oldest = reset.ok ? undefined : (reset.error.details as { oldest?: unknown });
              expect((await client.subscribe("software", oldest?.oldest as never)).ok).toBe(true);
              const notice = await client.waitForEvent(
                "software",
                (e) => e.type === "engine.notice",
                "the database notice",
              );
              expect(notice.data).toEqual({
                level: "error",
                code: "database.unavailable",
                text: status.stateReason,
              });
              const level = await client.command("daemon.setLogLevel", { level: "debug" });
              expect(level).toMatchObject({ ok: true, result: { level: "debug" } });
              expect(client.invalid).toEqual([]);
            } finally {
              await client.close();
            }

            // `dipo daemon status` prints the state with the reason that says what to do.
            const printed = await dipo(env, ["daemon", "status"]);
            expect(printed.code).toBe(0);
            expect(printed.out).toContain(`state:      recovering (${status.stateReason})`);

            // Still up a moment later: no exit, so no supervisor restart loop.
            await Bun.sleep(300);
            expect(daemon.exitCode).toBeNull();

            expect(await stopOverSocket(dir, daemon)).toBe(0);
            expect(existsSync(join(dir, "state", "dipo.pid"))).toBe(false);
          } finally {
            await kill(daemon);
          }
        });
      },
      TIMEOUT_MS,
    );

    it(
      "stays up after a failed migration, names the backup, and copying it in brings it back",
      async () => {
        await withDaemonTempDir(async (dir) => {
          const env = daemonTestEnv(dir);
          await headDatabase(dir);

          const failing = startFailing(env);
          let backup: string;
          try {
            const status = await waitForStatus(dir, failing, held);
            const refused = await refusals(dir);
            expect(refused).toMatchObject({
              code: "database.unavailable",
              retryable: false,
              details: { reason: "migration" },
            });
            backup = refused.details?.backup ?? "";
            expect(backup).toMatch(/\/state\/backups\/pre-v\d+-\d{8}T\d{6}\.db$/);
            expect(status.stateReason).toContain(
              "of the state database failed and was rolled back (no such table: no_such_table), so dipo.db was left as it was.",
            );
            expect(status.stateReason).toContain(
              "go back to the previous dipo version or upgrade to a release with a fixed migration",
            );
            expect(status.stateReason).toContain(
              `Copy the backup ${backup} over dipo.db, after deleting dipo.db-wal and dipo.db-shm, only if dipo.db itself is suspect.`,
            );
            expect(await stopOverSocket(dir, failing)).toBe(0);
          } finally {
            await kill(failing);
          }

          restoreByHand(dir, backup);

          const daemon = start(env);
          try {
            await waitForStatus(dir, daemon, running);
          } finally {
            await kill(daemon);
          }
          expect(daemon.exitCode).toBe(0);
        });
      },
      TIMEOUT_MS,
    );

    it(
      "stays up for a damaged file with the recovery-by-hand text, and copying the backup in brings it back",
      async () => {
        await withDaemonTempDir(async (dir) => {
          const env = daemonTestEnv(dir);
          const live = await headDatabase(dir);
          // A copy of a cleanly closed file is consistent: it stands in for a pre-migration backup.
          const backup = join(dir, "state", "backups", "pre-v1-20261016T000000.db");
          mkdirSync(join(dir, "state", "backups"), { recursive: true });
          copyFileSync(live, backup);
          damageHeader(live);
          const damagedBytes = readFileSync(live);

          const damaged = start(env);
          try {
            const status = await waitForStatus(dir, damaged, held);
            const refused = await refusals(dir);
            expect(refused).toMatchObject({
              code: "database.unavailable",
              retryable: false,
              message: status.stateReason,
              details: { reason: "damaged", backup },
            });
            expect(status.stateReason).toContain("The state database is damaged (");
            expect(status.stateReason).toContain(
              `Run \`dipo daemon stop\`, move ${join(dir, "state", "dipo.db")} and its -wal and -shm files away, or delete those two files and copy ${backup} over ${join(dir, "state", "dipo.db")}, then start the daemon again.`,
            );
            expect(await stopOverSocket(dir, damaged)).toBe(0);
          } finally {
            await kill(damaged);
          }

          // The daemon left the damaged file as it was: recovery is by hand (0007).
          expect(readFileSync(live).equals(damagedBytes)).toBe(true);
          restoreByHand(dir, backup);

          const daemon = start(env);
          try {
            await waitForStatus(dir, daemon, running);
          } finally {
            await kill(daemon);
          }
          expect(daemon.exitCode).toBe(0);
        });
      },
      TIMEOUT_MS,
    );
  });
}
