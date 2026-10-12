// The single-instance lock `<state>/dipo.pid` (0006 decision 6). No FFI and no `flock`: the record
// is created with `O_CREAT | O_EXCL`, liveness is PID plus start time (`process.ts`), and a stale
// record is broken by rename-and-verify so only one breaker wins.
//
// 1. Read the record. A live daemon that answers `engine.hello` and `daemon.status` with its own PID
//    over `ws+unix://` on its socket (`helloHandshake`) is reported as running.
// 2. Create the record exclusively. Success: this process is the instance.
// 3. It exists: a live `dipo daemon` gets up to 5 s to answer, then is reported unresponsive (code
//    never kills a live process on a guess). A dead PID, or a live one with another start time or
//    command, is stale: rename it aside, check the renamed file is the record judged stale, delete
//    it, or restore it with `link()` when another starter replaced it meanwhile. Back to step 1, at
//    most 3 times.
//
// After binding, the daemon re-reads the record (`verify`) before it opens the database (0007), and
// every minute `check` recreates a missing record or reports that another live daemon holds it.

import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import {
  type Clock,
  CONTRACT_VERSION,
  type ContractVersion,
  RequestId,
} from "@dipsaus-orchestrator/contract";

import { createUlid } from "./ids";
import { errorCode, readRuntimeRecord } from "./paths";
import { isDaemonCommand, isSameProcess, type ProcessProbe } from "./process";
import { connectUnixSocket } from "./socket";

export const PID_FILE = "dipo.pid";
export const LOCK_WAIT_MS = 5000;
export const LOCK_POLL_MS = 250;
export const MAX_STALE_BREAKS = 3;

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
  /** Random suffix for the renamed stale record. */
  readonly random?: () => string;
}

export type LockOutcome =
  | { readonly kind: "acquired"; readonly lock: HeldLock }
  | { readonly kind: "running"; readonly record: PidRecord }
  | { readonly kind: "unresponsive"; readonly record: PidRecord };

/** Thrown when three stale breaks did not lead to a lock or a running daemon. */
export class LockBreakError extends Error {
  constructor(readonly path: string) {
    super(
      `Could not take the lock ${path} after ${MAX_STALE_BREAKS} stale breaks; another starter keeps replacing it. Try again.`,
    );
    this.name = "LockBreakError";
  }
}

/** Result of the minute check. */
export type LockCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "recreated" }
  | { readonly kind: "lost"; readonly holder: PidRecord };

export interface HeldLock {
  readonly path: string;
  record(): PidRecord;
  /** Records the runtime directory in `dipo.pid`, by write-to-temp then rename. */
  setRuntimeDir(runtimeDir: string): void;
  /** The post-bind re-read: true when `dipo.pid` still holds this process's PID and start time. */
  verify(): boolean;
  /** The minute check. */
  check(): Promise<LockCheck>;
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

const sameIdentity = (a: PidRecord, b: PidRecord) =>
  a.pid === b.pid && a.startTimeMs === b.startTimeMs;

const defaultRandom = () => crypto.randomUUID().slice(0, 8);

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

/**
 * Breaks the stale record whose content was `staleRaw` (step 3): rename it aside, delete it if it
 * is still that record, otherwise put the newer record back with `link()`, which never clobbers.
 */
export function breakStaleRecord(
  path: string,
  staleRaw: string,
  ownPid: number,
  random: () => string = defaultRandom,
): "broken" | "restored" | "gone" {
  const aside = `${path}.stale.${ownPid}.${random()}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    // Another breaker moved it first.
    if (errorCode(error) === "ENOENT") return "gone";
    throw error;
  }
  const moved = readFileSync(aside, "utf8");
  if (moved === staleRaw) {
    unlinkSync(aside);
    return "broken";
  }
  try {
    linkSync(aside, path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  unlinkSync(aside);
  return "restored";
}

/** Takes `<state>/dipo.pid` (0006 decision 6 steps 1 to 3). */
export async function acquireLock(options: AcquireLockOptions): Promise<LockOutcome> {
  const { stateDir, self, probe, clock, handshake, logger } = options;
  const path = join(stateDir, PID_FILE);
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const random = options.random ?? defaultRandom;

  const isLiveDaemon = async (record: PidRecord) => {
    const info = await probe(record.pid);
    return isSameProcess(record, info) && info !== null && isDaemonCommand(info.command);
  };

  // Waits for the holder of `seen` to answer. "changed" sends the caller back to step 1.
  const waitForHolder = async (seen: RawRecord): Promise<"running" | "silent" | "changed"> => {
    const deadline = clock.now() + waitMs;
    for (;;) {
      if (seen.record !== null && (await handshake(seen.record))) return "running";
      if (clock.now() >= deadline) return "silent";
      await sleep(clock, pollMs);
      const now = readRaw(path);
      if (now === null || now.raw !== seen.raw) return "changed";
      if (seen.record !== null && !(await isLiveDaemon(seen.record))) return "changed";
    }
  };

  let breaks = 0;
  // Each pass either returns, breaks a stale record (at most MAX_STALE_BREAKS), or sees the record
  // change under it; the extra passes bound the last case.
  for (let pass = 0; pass < MAX_STALE_BREAKS * 4 + 4; pass++) {
    // Step 1.
    const current = readRaw(path);
    if (
      current?.record != null &&
      (await isLiveDaemon(current.record)) &&
      (await handshake(current.record))
    ) {
      return { kind: "running", record: current.record };
    }

    // Step 2.
    if (createExclusive(path, self)) {
      logger.info("took the daemon lock", { path, pid: self.pid });
      return { kind: "acquired", lock: heldLock(path, self, probe, random, logger) };
    }

    // Step 3.
    const seen = readRaw(path);
    if (seen === null) continue;
    if (seen.record === null) {
      // Unparsable: a starter between create and write, or damage left by a crash.
      const waited = await waitForHolder(seen);
      if (waited === "changed") continue;
    } else if (await isLiveDaemon(seen.record)) {
      const waited = await waitForHolder(seen);
      if (waited === "running") return { kind: "running", record: seen.record };
      if (waited === "silent") return { kind: "unresponsive", record: seen.record };
      continue;
    }

    if (breaks >= MAX_STALE_BREAKS) throw new LockBreakError(path);
    breaks++;
    const result = breakStaleRecord(path, seen.raw, self.pid, random);
    logger.warn("found a stale daemon lock", {
      path,
      pid: seen.record?.pid ?? null,
      result,
    });
  }
  throw new LockBreakError(path);
}

function heldLock(
  path: string,
  initial: PidRecord,
  probe: ProcessProbe,
  random: () => string,
  logger: LockLogger,
): HeldLock {
  let own = initial;
  const holdsOwn = () => {
    const current = readRaw(path);
    return current?.record != null && sameIdentity(current.record, own);
  };
  return {
    path,
    record: () => own,
    setRuntimeDir(runtimeDir) {
      own = { ...own, runtimeDir };
      if (!holdsOwn()) return;
      const temp = `${path}.${own.pid}.tmp`;
      writeFileSync(temp, formatPidRecord(own), { mode: 0o600 });
      renameSync(temp, path);
    },
    verify: holdsOwn,
    async check() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = readRaw(path);
        if (current === null) {
          if (createExclusive(path, own)) {
            logger.warn("recreated the missing daemon lock", { path });
            return { kind: "recreated" };
          }
          continue;
        }
        if (current.record !== null && sameIdentity(current.record, own)) return { kind: "ok" };
        if (
          current.record !== null &&
          isSameProcess(current.record, await probe(current.record.pid))
        ) {
          return { kind: "lost", holder: current.record };
        }
        // A foreign record of a dead process: break it and take the lock back.
        breakStaleRecord(path, current.raw, own.pid, random);
      }
      throw new LockBreakError(path);
    },
    release() {
      if (holdsOwn()) unlinkSync(path);
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
  /** The contract this binary speaks; tests send another major. */
  readonly contract?: ContractVersion;
  readonly timeoutMs?: number;
}

/**
 * Step 1's handshake (0006 decision 6): find the socket in `runtime.json`, send `engine.hello`
 * over `ws+unix://`, then `daemon.status`, and check the status names the record's PID. Both are
 * in the frozen surface (0005 section 11), so a daemon of another contract major answers too: its
 * `contract.unsupported` reply to the hello still counts as an answer.
 */
export function helloHandshake(
  options: HelloHandshakeOptions,
): (record: PidRecord) => Promise<boolean> {
  const { stateDir, clock } = options;
  const timeoutMs = options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const nextId = createUlid(clock);
  return async (record) => {
    const runtime = await readRuntimeRecord(stateDir);
    if (runtime === null || runtime.pid !== record.pid) return false;
    const client = await connectUnixSocket(runtime.socket, { clock, timeoutMs });
    if (client === null) return false;
    try {
      const hello = await client.request({
        kind: "read",
        requestId: RequestId.parse(nextId()),
        name: "engine.hello",
        args: { contract: options.contract ?? CONTRACT_VERSION, client: options.client },
      });
      if (hello === null) return false;
      if (!hello.ok && hello.error.code !== "contract.unsupported") return false;
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
