// The single-instance lock `<state>/dipo.pid` (0005). No FFI and no `flock`: the record is created
// with `O_CREAT | O_EXCL`, and liveness is PID plus start time (`process.ts`).
//
// 1. Read the record. When its PID is alive with the same start time and runs `dipo daemon`, a
//    daemon runs: it gets up to 5 s to answer `engine.hello` and `daemon.status` with its own PID
//    over `ws+unix://` (`helloHandshake`), else it is reported unresponsive. Code never removes a
//    live daemon's record.
// 2. Otherwise the record is stale: delete it, but only while the file still holds the bytes that
//    were judged stale. They are read again synchronously right before the unlink, so a record
//    another starter created meanwhile is never deleted; that starter won.
// 3. Create the record with `O_EXCL`. When that fails another starter won: back to step 1, once.

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { type Clock, RequestId } from "@dipsaus-orchestrator/contract";

import { createUlid } from "./ids";
import { errorCode, readRuntimeRecord } from "./paths";
import { isDaemonCommand, isSameProcess, type ProcessProbe } from "./process";
import { connectUnixSocket } from "./socket";

export const PID_FILE = "dipo.pid";
export const LOCK_WAIT_MS = 5000;
export const LOCK_POLL_MS = 250;

/** The content of `dipo.pid`. */
export interface PidRecord {
  readonly pid: number;
  /** Start time as `process.ts` reads it, ms since the epoch. */
  readonly startTimeMs: number;
  readonly version: string;
  /** The runtime directory in use; null until the holder has chosen it. */
  readonly runtimeDir: string | null;
}

/** The raw file and, when it parses, the record. */
interface RawRecord {
  readonly raw: string;
  readonly record: PidRecord | null;
}

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
  /** Step 1's handshake: true when the daemon of `record` answers on its socket. */
  readonly handshake: (record: PidRecord) => Promise<boolean>;
  readonly logger: LockLogger;
  readonly waitMs?: number;
  readonly pollMs?: number;
}

export type LockOutcome =
  | { readonly kind: "acquired"; readonly lock: HeldLock }
  | { readonly kind: "running"; readonly record: PidRecord }
  | { readonly kind: "unresponsive"; readonly record: PidRecord };

/** Thrown when another starter won step 3 twice, so neither a lock nor a daemon was found. */
export class LockBusyError extends Error {
  constructor(readonly path: string) {
    super(`Could not take the lock ${path}: another starter keeps taking it. Try again.`);
    this.name = "LockBusyError";
  }
}

export interface HeldLock {
  readonly path: string;
  record(): PidRecord;
  /** Records the runtime directory in `dipo.pid`, by write-to-temp then rename. */
  setRuntimeDir(runtimeDir: string): void;
  /** True when `dipo.pid` still holds this process's PID and start time. */
  holds(): boolean;
  /** Removes `dipo.pid` when it is still this process's record. */
  release(): void;
}

export function parsePidRecord(raw: string): PidRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<PidRecord>;
    if (
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.startTimeMs === "number" &&
      typeof value.version === "string" &&
      (value.runtimeDir === null || typeof value.runtimeDir === "string")
    ) {
      return {
        pid: value.pid,
        startTimeMs: value.startTimeMs,
        version: value.version,
        runtimeDir: value.runtimeDir,
      };
    }
  } catch {
    // Not JSON: a record being written, or damage. The caller decides.
  }
  return null;
}

export function formatPidRecord(record: PidRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function readRaw(path: string): RawRecord | null {
  try {
    const raw = readFileSync(path, "utf8");
    return { raw, record: parsePidRecord(raw) };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** Creates `path` with `O_CREAT | O_EXCL` and mode 0600; false when it exists. */
function createExclusive(path: string, record: PidRecord): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, formatPidRecord(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Deletes `path` (step 2) when it still holds `stale`, read again right before the unlink with no
 * await in between. True when it deleted; a record another starter removed or replaced first is
 * left alone.
 */
export function deleteStaleRecord(path: string, stale: string): boolean {
  if (readRaw(path)?.raw !== stale) return false;
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return false;
  }
  return true;
}

const sameIdentity = (a: PidRecord, b: PidRecord) =>
  a.pid === b.pid && a.startTimeMs === b.startTimeMs;

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

/** Takes `<state>/dipo.pid` (0005, steps 1 to 3). */
export async function acquireLock(options: AcquireLockOptions): Promise<LockOutcome> {
  const { stateDir, self, probe, clock, handshake, logger } = options;
  const path = join(stateDir, PID_FILE);
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;

  const isLiveDaemon = async (record: PidRecord) => {
    const info = await probe(record.pid);
    return isSameProcess(record, info) && info !== null && isDaemonCommand(info.command);
  };

  // A live daemon gets `waitMs` to answer: one that just took the lock binds its socket after it.
  const answers = async (record: PidRecord): Promise<boolean> => {
    const deadline = clock.now() + waitMs;
    for (;;) {
      if (await handshake(record)) return true;
      if (clock.now() >= deadline || !(await isLiveDaemon(record))) return false;
      await sleep(clock, pollMs);
    }
  };

  for (let pass = 0; pass < 2; pass++) {
    // Step 1.
    let current = readRaw(path);
    if (current !== null && current.record === null) {
      // Unparsable: a starter between its create and its write, or damage. One poll tells.
      await sleep(clock, pollMs);
      current = readRaw(path);
    }
    if (current?.record != null && (await isLiveDaemon(current.record))) {
      const record = current.record;
      if (await answers(record)) return { kind: "running", record };
      if (await isLiveDaemon(record)) return { kind: "unresponsive", record };
    }
    // Step 2.
    if (current !== null && deleteStaleRecord(path, current.raw)) {
      logger.warn("removed a stale daemon lock", { path, pid: current.record?.pid ?? null });
    }
    // Step 3.
    if (createExclusive(path, self)) {
      logger.info("took the daemon lock", { path, pid: self.pid });
      return { kind: "acquired", lock: heldLock(path, self) };
    }
  }
  throw new LockBusyError(path);
}

function heldLock(path: string, initial: PidRecord): HeldLock {
  let own = initial;
  const holds = () => {
    const current = readRaw(path);
    return current?.record != null && sameIdentity(current.record, own);
  };
  return {
    path,
    record: () => own,
    setRuntimeDir(runtimeDir) {
      own = { ...own, runtimeDir };
      if (!holds()) return;
      const temp = `${path}.${own.pid}.tmp`;
      writeFileSync(temp, formatPidRecord(own), { mode: 0o600 });
      renameSync(temp, path);
    },
    holds,
    release() {
      if (holds()) unlinkSync(path);
    },
  };
}

/** How long step 1 waits for the socket to accept and for each reply. */
export const HANDSHAKE_TIMEOUT_MS = 1000;

export interface HelloHandshakeOptions {
  readonly stateDir: string;
  readonly clock: Clock;
  /** Who is asking, sent in `engine.hello`. */
  readonly client: { readonly name: string; readonly version: string };
  readonly timeoutMs?: number;
}

/**
 * Step 1's handshake (0005): find the socket in `runtime.json` written by the process the record
 * names (same PID and start time), send `engine.hello` over `ws+unix://`, then `daemon.status`, and
 * check the status names the record's PID. A daemon of another version may refuse this binary's
 * hello (one from before 0005's single version does); then the status is refused too, the daemon
 * counts as not answering, and step 1 reports it unresponsive: its record is never deleted.
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
