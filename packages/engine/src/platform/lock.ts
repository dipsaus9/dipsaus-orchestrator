// The single-instance lock (0005): an exclusive SQLite lock on `<state>/dipo.lock`, held on one
// connection for the daemon's whole life. SQLite takes it with `fcntl` locks, which belong to the
// process: the operating system drops them when the process exits, also on SIGKILL. So no starter
// ever judges a lock stale, and two processes never both hold it.
//
// 1. Refuse a state folder on a network filesystem, where SQLite's lock may exclude nobody. Open
//    `dipo.lock` in the real state folder (created when missing, refused when it is a
//    symbolic link) and take the lock: `BEGIN EXCLUSIVE` and one write, kept open and never
//    committed. The write fails on a file SQLite could open only read-only, whose lock would
//    exclude nobody. Any error but "busy" stops the start: the daemon never runs without the lock.
//    Each attempt waits up to `LOCK_BUSY_MS` for a lock another starter's attempt holds for a
//    moment: two starters at the same moment would otherwise each see the other, both give up and
//    retry in step, and both report the lock held while nobody holds it.
//    The file stays when the daemon exits: removing it would let a starter that opened it before
//    the removal and one that creates a new file both hold a lock.
// 2. Taken: when `dipo.pid` still names another live `dipo daemon`, that daemon holds no lock on
//    this file (its `dipo.lock` was removed or replaced, or it predates this lock): let the lock go
//    and treat it as in step 3, never run beside it. Otherwise write `dipo.pid` (PID, start time,
//    version, later the runtime directory), the record clients read, by write-to-temp then rename.
//    Only the holder writes it, and a dead process's record never stops it.
// 3. Busy: another process holds it. When `dipo.pid` names a live `dipo daemon` that answers
//    `engine.hello` and `daemon.status` with its own PID over `ws+unix://` (`helloHandshake`)
//    within 5 s, it runs; a live daemon that does not answer is unresponsive; otherwise the holder is
//    unknown. A lock that comes free during the wait is taken.
//
// Nothing else in the daemon opens `dipo.lock` (`test/platform/lock-file-owner.test.ts`): with
// POSIX locks, closing a second descriptor of the file in the same process drops the lock.

import { Database } from "bun:sqlite";
import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type Clock,
  formatPidRecord,
  isDaemonCommand,
  isSameProcess,
  LOCK_FILE,
  parsePidRecord,
  PID_FILE,
  type PidRecord,
  type ProcessProbe,
  RequestId,
} from "@dipsaus-orchestrator/contract";

import { createUlid } from "./ids";
import { errorCode, readRuntimeRecord } from "./paths";
import { connectUnixSocket } from "./socket";
import {
  isNetworkFsType,
  mountFor,
  type MountReader,
  NetworkFileSystemError,
  readSystemMounts,
} from "./sqlite";

export {
  formatPidRecord,
  LOCK_FILE,
  parsePidRecord,
  PID_FILE,
  type PidRecord,
} from "@dipsaus-orchestrator/contract";
export const LOCK_WAIT_MS = 5000;
export const LOCK_POLL_MS = 250;
/** How long one attempt waits, blocking, for another process's lock to go (SQLite's busy timeout). */
const LOCK_BUSY_MS = 100;

// <sqlite3.h>: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOFOLLOW.
const OPEN_FLAGS = 0x2 | 0x4 | 0x0100_0000;

/**
 * The connections that hold a lock, until released. A connection the garbage collector finalizes
 * is closed, which drops its lock: this set keeps it reachable whatever its caller keeps.
 */
const holding = new Set<Database>();

export interface LockLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface AcquireLockOptions {
  readonly stateDir: string;
  /** This process's record; `runtimeDir` is null, it is chosen after the lock is held. */
  readonly self: PidRecord;
  readonly probe: ProcessProbe;
  readonly clock: Clock;
  /** Step 3's handshake: true when the daemon of `record` answers on its socket. */
  readonly handshake: (record: PidRecord) => Promise<boolean>;
  readonly logger: LockLogger;
  readonly waitMs?: number;
  readonly pollMs?: number;
  /** Replaces the system mount table, for tests. */
  readonly readMounts?: MountReader;
}

export type LockOutcome =
  | { readonly kind: "acquired"; readonly lock: HeldLock }
  | { readonly kind: "running"; readonly record: PidRecord }
  | { readonly kind: "unresponsive"; readonly record: PidRecord }
  /** Held by a process `dipo.pid` does not name as a live daemon; `record` is what it holds. */
  | { readonly kind: "held"; readonly path: string; readonly record: PidRecord | null };

/** Step 1 failed for another reason than another holder: the lock file cannot be used. */
export class LockFileError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(
      `cannot take the daemon lock ${path}: ${cause instanceof Error ? cause.message : String(cause)} (${errorCode(cause) ?? "no code"})`,
      { cause },
    );
    this.name = "LockFileError";
  }
}

export interface HeldLock {
  /** The lock file. */
  readonly path: string;
  record(): PidRecord;
  /** Records the runtime directory in `dipo.pid`, by write-to-temp then rename. */
  setRuntimeDir(runtimeDir: string): void;
  /** Removes `dipo.pid`, then drops the lock. */
  release(): void;
}

/** Opens the lock file (step 1); throws `LockFileError` when it cannot. */
function openLockFile(path: string): Database {
  let db: Database;
  try {
    db = new Database(path, OPEN_FLAGS);
  } catch (error) {
    throw new LockFileError(path, error);
  }
  // With a busy timeout, the attempt that already has the lock half taken keeps it and waits for
  // the other attempt to let go, so one of two starters at the same moment always takes it.
  db.run(`PRAGMA busy_timeout = ${LOCK_BUSY_MS}`);
  return db;
}

/**
 * Takes the lock on `db` (step 1): true when taken, false when another process holds it. The write
 * stays in the open transaction, so the file is never changed; it only proves SQLite opened the
 * file for writing, without which its lock would exclude nobody.
 */
function take(db: Database, path: string): boolean {
  try {
    // An in-memory journal: no `dipo.lock-journal` file next to the lock.
    db.run("PRAGMA journal_mode = MEMORY");
    db.run("BEGIN EXCLUSIVE");
  } catch (error) {
    if (errorCode(error) === "SQLITE_BUSY") return false;
    throw new LockFileError(path, error);
  }
  try {
    db.run("PRAGMA user_version = 1");
  } catch (error) {
    // The caller closes `db`, which ends the transaction.
    throw new LockFileError(path, error);
  }
  return true;
}

function readRecord(file: string): PidRecord | null {
  try {
    return parsePidRecord(readFileSync(file, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** Writes `dipo.pid` by write-to-temp then rename, so a reader never sees half a record. */
function writeRecord(file: string, record: PidRecord): void {
  const temp = `${file}.${record.pid}.tmp`;
  writeFileSync(temp, formatPidRecord(record), { mode: 0o600 });
  renameSync(temp, file);
}

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

/** Step 1's refusal: a state folder on a network filesystem. */
async function refuseNetworkFolder(realState: string, readMounts: MountReader): Promise<void> {
  const mounts = await readMounts();
  const mount = mounts === null ? undefined : mountFor(realState, mounts);
  if (mount !== undefined && isNetworkFsType(mount.fsType)) {
    throw new NetworkFileSystemError(realState, mount.fsType);
  }
}

/** Takes `<state>/dipo.lock` (0005, steps 1 to 3). */
export async function acquireLock(options: AcquireLockOptions): Promise<LockOutcome> {
  const { stateDir, self, probe, clock, handshake, logger } = options;
  // The real folder, so the symbolic link refusal concerns the lock file alone.
  const realState = realpathSync(stateDir);
  await refuseNetworkFolder(realState, options.readMounts ?? readSystemMounts);
  const path = join(realState, LOCK_FILE);
  const pidPath = join(stateDir, PID_FILE);
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;

  /** True when `record` names a live `dipo daemon` other than this process. */
  const isOtherLiveDaemon = async (record: PidRecord | null): Promise<boolean> => {
    if (record === null || record.pid === self.pid) return false;
    const info = await probe(record.pid);
    return isSameProcess(record, info) && info !== null && isDaemonCommand(info.command);
  };

  const db = openLockFile(path);
  let held = false;
  try {
    // A daemon that just took the lock writes `dipo.pid` and binds its socket after it: wait for it.
    const deadline = clock.now() + waitMs;
    let record: PidRecord | null = null;
    let warned = false;
    for (;;) {
      const took = take(db, path);
      record = readRecord(pidPath);
      const other = await isOtherLiveDaemon(record);
      if (took && !other) {
        held = true;
        writeRecord(pidPath, self);
        logger.info("took the daemon lock", { path, pid: self.pid });
        return { kind: "acquired", lock: heldLock(db, path, pidPath, self) };
      }
      if (took) {
        // Step 2: a live daemon that holds no lock on this file. Let the lock go.
        db.run("ROLLBACK");
        if (!warned) {
          warned = true;
          logger.warn("dipo.pid names a live daemon that does not hold dipo.lock; not taking it", {
            path,
            pid: record?.pid ?? null,
          });
        }
      }
      if (record !== null && other && (await handshake(record))) {
        return { kind: "running", record };
      }
      if (clock.now() >= deadline) break;
      await sleep(clock, pollMs);
    }
    if (record !== null && (await isOtherLiveDaemon(record))) {
      return { kind: "unresponsive", record };
    }
    return { kind: "held", path, record };
  } finally {
    if (!held) db.close();
  }
}

function heldLock(db: Database, path: string, pidPath: string, initial: PidRecord): HeldLock {
  let own = initial;
  holding.add(db);
  return {
    path,
    record: () => own,
    setRuntimeDir(runtimeDir) {
      own = { ...own, runtimeDir };
      writeRecord(pidPath, own);
    },
    release() {
      // `dipo.pid` goes while the lock is still held, so it never removes the next holder's record.
      try {
        unlinkSync(pidPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      db.close();
      holding.delete(db);
    },
  };
}

/** How long step 3 waits for the socket to accept and for each reply. */
export const HANDSHAKE_TIMEOUT_MS = 1000;

export interface HelloHandshakeOptions {
  readonly stateDir: string;
  readonly clock: Clock;
  /** Who is asking, sent in `engine.hello`. */
  readonly client: { readonly name: string; readonly version: string };
  readonly timeoutMs?: number;
}

/**
 * Step 3's handshake (0005): find the socket in `runtime.json` written by the process the record
 * names (same PID and start time), send `engine.hello` over `ws+unix://`, then `daemon.status`, and
 * check the status names the record's PID. A daemon of another version may refuse this binary's
 * hello (one from before 0005's single version does); then the status is refused too, the daemon
 * counts as not answering, and step 3 reports it unresponsive.
 */
export function helloHandshake(
  options: HelloHandshakeOptions,
): (record: PidRecord) => Promise<boolean> {
  const { stateDir, clock } = options;
  const timeoutMs = options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const nextId = createUlid(clock);
  return async (record) => {
    const runtime = await readRuntimeRecord(stateDir);
    // The socket must belong to the process the record names: same PID and same start time. The
    // caller has already checked that start time against the live process.
    if (
      runtime === null ||
      runtime.pid !== record.pid ||
      runtime.startTimeMs !== record.startTimeMs
    ) {
      return false;
    }
    const client = await connectUnixSocket(runtime.socket, { clock, timeoutMs });
    if (client === null) return false;
    try {
      const hello = await client.request({
        kind: "read",
        requestId: RequestId.parse(nextId()),
        name: "engine.hello",
        args: { client: options.client },
      });
      if (hello === null) return false;
      const status = await client.request({
        kind: "read",
        requestId: RequestId.parse(nextId()),
        name: "daemon.status",
        args: {},
      });
      if (status === null || !status.ok) return false;
      const pid = (status.result as { pid?: unknown } | undefined)?.pid;
      return pid === record.pid;
    } finally {
      client.close();
    }
  };
}
