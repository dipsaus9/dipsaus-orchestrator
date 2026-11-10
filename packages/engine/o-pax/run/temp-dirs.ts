// The run temp directories' lifetime (DIPO-102, DIPO-118). Each story run gets
// `<tmpRoot>/dipo-run-<run id>` (the worker's `TMPDIR`, with the Safe-Chain install caches of DIPO-84
// inside) and a short temp root `<tmpRoot>/dipo-t-<hash>`, the worker's `DIPO_TMP`, short enough
// for testkit's Unix socket path limit (37 bytes, DIPO-109). Its name is a hash of the run id, so
// it is known from the run id alone; a `.dipo-run` file inside names the run, and the sweep maps
// the directory to that run only when the name is that run's hash. Once the run has ended (done,
// failed, stopped, parked) and its worker hosts have exited, both directories go:
//
// - `sweep("ended")` runs when a session's exit is ingested and after the exit is
//   decided (`afterRunExits`), so a run that ends before or after its worker exits loses its
//   directory then. Only runs this daemon's database knows to have ended are touched.
// - `sweep("recovery")` runs once at daemon start, after reconcile and re-attach. It also removes
//   the directory of a run the database does not know (a lost database, a crash between the
//   directory and the run row), but only when the directory's owner file names this daemon's
//   database, so another daemon's runs under the same temp root (another `DIPO_HOME`) stay. It
//   also removes this user's `dipo-out-*` folders of a child's output files that a crash left
//   between the spawn and the read, once nothing in them changed for a few minutes (DIPO-333,
//   `sweepOutputDirs`).
//
// What is never removed: a run that has not ended (live, held, re-attachable), an ended run with a
// worker host that still runs, a claim that is still live, anything that is not a real directory
// named `dipo-run-<run id>` or `dipo-t-<hash>` directly under the temp root and owned by this user,
// a short temp root whose run file names another run, nothing through a symlink, and nothing
// another daemon made. A short temp root whose run file is missing or does not match its name is
// found only through its run's `dipo-run-<run id>` directory. Of a run no database row names, each
// directory goes only when its own owner file names this daemon's database. A parked run that is
// reopened (DIPO-75) loses its directories at the park; its next session makes fresh ones
// (`RunResumer`), after the reopen cleared its end, and the check right before each removal is
// synchronous, so a reopened run never loses the new directories.

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Clock, OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import type { StateDatabase } from "../db/database";
import type { OfficeHandle } from "../db/office";
import { systemClock } from "../platform/clock";
import { sweepOutputDirs } from "../platform/output-files";
import { ensurePrivateDir, errorCode } from "../platform/paths";
import type { ProcessProbe } from "../platform/process";
import type { RunLaunchPaths } from "../workers/port";
import { hostAlive, workerHostsOf, type WorkerHostRow } from "../records/worker-hosts";

import type { RunOutcomesPort } from "./outcomes";
import type { RunView } from "./outcome-types";
import { findRun } from "../records/run-records";

/** The recovery step that sweeps run temp directories at daemon start, after re-attach. */
export const RUN_TEMP_SWEEP_STEP = "run-temp-sweep";

/** The name prefix of a run temp directory under the temp root. */
export const RUN_TEMP_PREFIX = "dipo-run-";

/** The file in a run temp directory that names the database of the daemon that made it. */
export const RUN_TEMP_OWNER_FILE = ".dipo-owner";

/** The name prefix of a run's short temp root, the worker's `DIPO_TMP` (DIPO-118). */
export const SHORT_TEMP_PREFIX = "dipo-t-";

/** The file in a short temp root that names its run. */
export const SHORT_TEMP_RUN_FILE = ".dipo-run";

/**
 * The longest short temp root testkit accepts as `DIPO_TMP` after symlinks (`MAX_TEMP_ROOT_BYTES`,
 * DIPO-109): a test daemon's socket paths under a longer one would pass the Unix socket path
 * limit. Under the default temp root (`/tmp`, real path `/private/tmp` on macOS) the root is 30
 * bytes on macOS and 22 on Linux. Under a daemon `DIPO_TMP` over 19 bytes it is longer, and
 * testkit refuses it inside the worker as it would refuse that `DIPO_TMP` itself.
 */
export const SHORT_TEMP_MAX_BYTES = 37;

/** Hex characters of the run id's hash in a short temp root's name. */
const SHORT_TEMP_HASH_LENGTH = 10;

/** A run id as it may appear in a directory name: no separator, no dots. */
const RUN_ID_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** The owner file is one short line; anything longer is not ours. */
const OWNER_MAX_BYTES = 128;

/** `<tmpRoot>/dipo-run-<run id>`. */
export function runTempDir(tmpRoot: string, runId: string): string {
  return join(tmpRoot, `${RUN_TEMP_PREFIX}${runId}`);
}

/**
 * `<tmpRoot>/dipo-t-<hash>`: the first 10 hex characters of the run id's sha256, so the name is
 * 17 bytes and `/private/tmp/dipo-t-<hash>` 30 (DIPO-118).
 */
export function shortTempDir(tmpRoot: string, runId: string): string {
  return join(tmpRoot, shortTempName(runId));
}

function shortTempName(runId: string): string {
  const hash = createHash("sha256").update(runId).digest("hex");
  return `${SHORT_TEMP_PREFIX}${hash.slice(0, SHORT_TEMP_HASH_LENGTH)}`;
}

/** The owner a daemon writes into its run temp directories: a hash of its database's path. */
export function runTempOwner(databasePath: string): string {
  return createHash("sha256").update(databasePath).digest("hex").slice(0, 32);
}

/**
 * Makes the run temp directory (0700) and, given an owner, its owner file. The file is created
 * anew (`wx`), so a link left in its place is removed, never written through.
 */
export function prepareRunTempDir(tmpDir: string, owner: string | undefined): void {
  ensurePrivateDir(tmpDir);
  if (owner === undefined) return;
  const file = join(tmpDir, RUN_TEMP_OWNER_FILE);
  rmSync(file, { force: true });
  writeFileSync(file, `${owner}\n`, { flag: "wx", mode: 0o600 });
}

/**
 * Makes a run's short temp root (0700) with its run file and, given an owner, its owner file. A
 * directory already there is reused only when it is a real directory this user owns whose run
 * file, if any, names this run; anything else (a link, another user's directory, another run's
 * directory with the same hash) throws, so the worker is never given a root someone else controls.
 */
export function prepareShortTempDir(
  dir: string,
  runId: string,
  owner: string | undefined,
  uid = currentUid(),
): void {
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`${dir} is not a directory of this user; remove it and start the run again`);
  }
  const named = readTempLine(dir, SHORT_TEMP_RUN_FILE);
  if (named !== null && named !== runId) {
    throw new Error(
      `${dir} belongs to run ${named}, not ${runId}; remove it and start the run again`,
    );
  }
  chmodSync(dir, 0o700);
  writeFresh(join(dir, SHORT_TEMP_RUN_FILE), runId);
  if (owner !== undefined) writeFresh(join(dir, RUN_TEMP_OWNER_FILE), owner);
}

/** Both temp directories of a run session (DIPO-102, DIPO-118), made before every launch. */
export function prepareRunTempDirs(
  paths: Pick<RunLaunchPaths, "tmpDir" | "shortTmpDir">,
  runId: string,
  owner: string | undefined,
): void {
  prepareRunTempDir(paths.tmpDir, owner);
  prepareShortTempDir(paths.shortTmpDir, runId, owner);
}

/** Writes `line` into a new file; a link left in its place is removed, never written through. */
function writeFresh(file: string, line: string): void {
  rmSync(file, { force: true });
  writeFileSync(file, `${line}\n`, { flag: "wx", mode: 0o600 });
}

/** The owner file's text, or null. Never follows a link and never blocks on a FIFO. */
export function readRunTempOwner(tmpDir: string): string | null {
  return readTempLine(tmpDir, RUN_TEMP_OWNER_FILE);
}

/** The run a short temp root's run file names, or null. Read like the owner file. */
export function readShortTempRun(dir: string): string | null {
  return readTempLine(dir, SHORT_TEMP_RUN_FILE);
}

/** A one-line file in a temp directory, trimmed, or null. */
function readTempLine(dir: string, name: string): string | null {
  let fd: number;
  try {
    fd = openSync(
      join(dir, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > OWNER_MAX_BYTES) return null;
    const buffer = Buffer.alloc(OWNER_MAX_BYTES);
    const read = readSync(fd, buffer, 0, OWNER_MAX_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8").trim();
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The uid of this process, or undefined where it has none. */
function currentUid(): number | undefined {
  return process.getuid?.();
}

/**
 * True when `<tmpRoot>/dipo-run-<runId>` is a real directory (not a link) owned by `uid`; the
 * only kind of path the removal touches.
 */
export function isRunTempDir(tmpRoot: string, runId: string, uid = currentUid()): boolean {
  return RUN_ID_NAME.test(runId) && isOwnDir(runTempDir(tmpRoot, runId), uid);
}

/** The same for the run's short temp root `<tmpRoot>/dipo-t-<hash>` (DIPO-118). */
export function isShortTempDir(tmpRoot: string, runId: string, uid = currentUid()): boolean {
  return RUN_ID_NAME.test(runId) && isOwnDir(shortTempDir(tmpRoot, runId), uid);
}

function isOwnDir(dir: string, uid: number | undefined): boolean {
  try {
    const info = lstatSync(dir);
    return !info.isSymbolicLink() && info.isDirectory() && (uid === undefined || info.uid === uid);
  } catch {
    return false;
  }
}

/**
 * Removes `<tmpRoot>/dipo-run-<runId>` when it is a real directory owned by `uid`. The recursive
 * removal unlinks links inside it and never follows them. True when it removed the directory.
 */
export function removeRunTempDir(tmpRoot: string, runId: string, uid = currentUid()): boolean {
  if (!isRunTempDir(tmpRoot, runId, uid)) return false;
  rmSync(runTempDir(tmpRoot, runId), { recursive: true, force: true });
  return true;
}

/**
 * Removes the run's short temp root as `removeRunTempDir` does, but never one whose run file
 * names another run (a hash shared by two run ids). True when it removed the directory.
 */
export function removeShortTempDir(tmpRoot: string, runId: string, uid = currentUid()): boolean {
  if (!isShortTempDir(tmpRoot, runId, uid)) return false;
  const dir = shortTempDir(tmpRoot, runId);
  const named = readShortTempRun(dir);
  if (named !== null && named !== runId) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * The run a short temp root under `tmpRoot` belongs to: the run its run file names, when that
 * run's hash is the directory's name and the directory is a real one owned by `uid`; else null.
 */
function shortTempRunOf(tmpRoot: string, name: string, uid: number | undefined): string | null {
  const dir = join(tmpRoot, name);
  if (!isOwnDir(dir, uid)) return null;
  const runId = readShortTempRun(dir);
  if (runId === null || !RUN_ID_NAME.test(runId) || shortTempName(runId) !== name) return null;
  return runId;
}

/** `ended`: runs the database knows ended. `recovery`: also unknown runs with this owner. */
export type RunTempSweep = "ended" | "recovery";

export interface RunTempDirsDeps {
  /** The real path of the temp root (`/tmp` is a link on macOS). */
  readonly tmpRoot: string;
  /** The daemon's state database; nothing is swept while it is not open. */
  readonly database: () => StateDatabase | null;
  readonly probe: ProcessProbe;
  /** The uid the directories must belong to; this process's by default. */
  readonly uid?: number;
  readonly warn?: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  /** The age of a left-over output folder is taken against it; the system clock by default. */
  readonly clock?: Clock;
}

/** A synchronous check, made right before the removal, that the verdict still holds. */
type StillRemovable = () => boolean;

/**
 * A run whose directories may go: `still` is checked right before the removal; with `owner` (a
 * run no database row names) each directory goes only when its own owner file names it.
 */
interface Removable {
  readonly still: StillRemovable;
  readonly owner?: string;
}

function hostExited(host: WorkerHostRow): boolean {
  return host.endedAt !== null || host.exitCode !== null || host.exitSignal !== null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RunTempDirs {
  readonly #deps: RunTempDirsDeps;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: RunTempDirsDeps) {
    this.#deps = deps;
  }

  /** The owner this daemon writes into new run temp directories; undefined before the database. */
  owner(): string | undefined {
    const database = this.#deps.database();
    return database === null ? undefined : runTempOwner(database.connection.path);
  }

  /** Removes what `mode` allows; sweeps run one at a time. Returns the directories removed. */
  sweep(mode: RunTempSweep): Promise<string[]> {
    const next = this.#queue.then(
      () => this.#sweep(mode),
      () => this.#sweep(mode),
    );
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #sweep(mode: RunTempSweep): Promise<string[]> {
    const database = this.#deps.database();
    if (database === null) return [];
    const { tmpRoot } = this.#deps;
    let names: string[];
    try {
      names = readdirSync(tmpRoot);
    } catch {
      return [];
    }
    const { uid } = this.#deps;
    // The runs the directories belong to: a run temp directory by its name, a short temp root by
    // its run file checked against its name (DIPO-118).
    const runs = new Set<string>();
    for (const name of names) {
      if (name.startsWith(RUN_TEMP_PREFIX)) {
        const runId = name.slice(RUN_TEMP_PREFIX.length);
        if (isRunTempDir(tmpRoot, runId, uid)) runs.add(runId);
      } else if (name.startsWith(SHORT_TEMP_PREFIX)) {
        const runId = shortTempRunOf(tmpRoot, name, uid);
        if (runId !== null) runs.add(runId);
      }
    }
    // Output folders of spawned children a crash left behind (DIPO-333).
    const removed =
      mode === "recovery"
        ? sweepOutputDirs(tmpRoot, (this.#deps.clock ?? systemClock).now(), uid)
        : [];
    for (const runId of runs) {
      try {
        const verdict = await this.#removable(database, runId, mode);
        if (verdict === null || !verdict.still()) continue;
        const kinds = [
          [runTempDir(tmpRoot, runId), removeRunTempDir],
          [shortTempDir(tmpRoot, runId), removeShortTempDir],
        ] as const;
        for (const [dir, remove] of kinds) {
          if (verdict.owner !== undefined && readRunTempOwner(dir) !== verdict.owner) continue;
          if (remove(tmpRoot, runId, uid)) removed.push(dir);
        }
      } catch (error) {
        this.#deps.warn?.("removing a run temp directory failed", {
          dir: runTempDir(tmpRoot, runId),
          reason: messageOf(error),
        });
      }
    }
    return removed;
  }

  /** Null when the run's directories stay; else when and which of them go. */
  async #removable(
    database: StateDatabase,
    runId: string,
    mode: RunTempSweep,
  ): Promise<Removable | null> {
    const connection = database.connection;
    const row = connection.get<{ office_id: string }>(
      "select office_id from runs where run_id = $run limit 1",
      { run: runId },
    );
    if (row !== null) {
      const still = await this.#endedRun(
        database.office(row.office_id as OfficeId),
        runId as RunId,
      );
      return still === null ? null : { still };
    }
    // A claim without a run row: its setup was under way. A live claim keeps the directory.
    const claimed = () =>
      connection.get<{ live: number }>(
        `select max(released_at is null) as live from claims where run_id = $run`,
        { run: runId },
      )?.live ?? null;
    const unknown = () =>
      connection.get("select 1 from runs where run_id = $run", { run: runId }) === null;
    const live = claimed();
    if (live !== null) return live === 0 ? { still: () => unknown() && claimed() === 0 } : null;
    if (mode !== "recovery") return null;
    // A run no database row names: only the directories this daemon's database made.
    const owner = this.owner();
    if (owner === undefined) return null;
    return { still: () => unknown() && claimed() === null, owner };
  }

  /** An ended run whose worker hosts all exited; the check sees no reopen and no new host. */
  async #endedRun(office: OfficeHandle, runId: RunId): Promise<StillRemovable | null> {
    if (findRun(office, runId)?.endedAt == null) return null;
    const hosts = workerHostsOf(office, runId);
    for (const host of hosts) {
      if (hostExited(host)) continue;
      let alive: boolean;
      try {
        alive = await hostAlive(host, this.#deps.probe);
      } catch {
        alive = true;
      }
      if (alive) return null;
    }
    return () =>
      findRun(office, runId)?.endedAt != null &&
      workerHostsOf(office, runId).length === hosts.length;
  }
}

/**
 * `port` with `after` called once each exit is decided, with the run's view: the run
 * may have ended there, after its worker exited (DIPO-102).
 */
export function afterRunExits(
  port: RunOutcomesPort,
  after: (view: RunView) => void,
): RunOutcomesPort {
  const wrapped: RunOutcomesPort = {
    onTurnProblem: (view, problem) => port.onTurnProblem(view, problem),
    onPlanLimit: (view, limit) => port.onPlanLimit(view, limit),
    onModelSwitched: (view, model) => port.onModelSwitched(view, model),
    answered: (view) => port.answered(view),
    onExit: async (exit) => {
      try {
        await port.onExit(exit);
      } finally {
        after(exit.view);
      }
    },
  };
  return {
    ...wrapped,
    ...(port.onReview === undefined
      ? {}
      : { onReview: (view, report) => port.onReview?.(view, report) ?? Promise.resolve() }),
  };
}
