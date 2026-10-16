// The run temp directory's lifetime (DIPO-102). Each story run gets `<tmpRoot>/dipo-run-<run id>`
// (the worker's `TMPDIR`, with the Safe-Chain install caches of DIPO-84 inside). Once the run has
// ended (done, failed, stopped, parked) and its worker hosts have exited, the directory goes:
//
// - `sweep("ended")` runs when a session's exit is ingested and after the exit or a lost host is
//   decided (`afterRunExits`), so a run that ends before or after its worker exits loses its
//   directory then. Only runs this daemon's database knows to have ended are touched.
// - `sweep("recovery")` runs once at daemon start, after reconcile and re-attach. It also removes
//   the directory of a run the database does not know (a lost database, a crash between the
//   directory and the run row), but only when the directory's owner file names this daemon's
//   database, so another daemon's runs under the same temp root (another `DIPO_HOME`) stay.
//
// What is never removed: a run that has not ended (live, held, re-attachable), an ended run with a
// worker host that still runs, a claim that is still live, anything that is not a real directory
// named `dipo-run-<run id>` directly under the temp root and owned by this user, and nothing
// through a symlink. A parked run that is reopened (DIPO-75) loses its directory at the park; its
// next session makes a fresh one (`RunResumer`), after the reopen cleared its end, and the check
// right before each removal is synchronous, so a reopened run never loses the new directory.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { OfficeId, RunId } from "@dipsaus-orchestrator/contract";

import type { StateDatabase } from "../db/database";
import type { OfficeHandle } from "../db/office";
import { ensurePrivateDir } from "../platform/paths";
import type { ProcessProbe } from "../platform/process";
import { hostAlive, workerHostsOf, type WorkerHostRow } from "../runs/worker-hosts";

import type { RunOutcomesPort } from "./outcomes";
import { findRun } from "./records";

/** The recovery step that sweeps run temp directories at daemon start, after re-attach. */
export const RUN_TEMP_SWEEP_STEP = "run-temp-sweep";

/** The name prefix of a run temp directory under the temp root. */
export const RUN_TEMP_PREFIX = "dipo-run-";

/** The file in a run temp directory that names the database of the daemon that made it. */
export const RUN_TEMP_OWNER_FILE = ".dipo-owner";

/** A run id as it may appear in a directory name: no separator, no dots. */
const RUN_ID_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** The owner file is one short line; anything longer is not ours. */
const OWNER_MAX_BYTES = 128;

/** `<tmpRoot>/dipo-run-<run id>`. */
export function runTempDir(tmpRoot: string, runId: string): string {
  return join(tmpRoot, `${RUN_TEMP_PREFIX}${runId}`);
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

/** The owner file's text, or null. Never follows a link and never blocks on a FIFO. */
export function readRunTempOwner(tmpDir: string): string | null {
  let fd: number;
  try {
    fd = openSync(
      join(tmpDir, RUN_TEMP_OWNER_FILE),
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
  if (!RUN_ID_NAME.test(runId)) return false;
  try {
    const info = lstatSync(runTempDir(tmpRoot, runId));
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
}

/** A synchronous check, made right before the removal, that the verdict still holds. */
type StillRemovable = () => boolean;

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
    const removed: string[] = [];
    for (const name of names) {
      if (!name.startsWith(RUN_TEMP_PREFIX)) continue;
      const runId = name.slice(RUN_TEMP_PREFIX.length);
      if (!isRunTempDir(tmpRoot, runId, this.#deps.uid)) continue;
      try {
        const still = await this.#removable(database, runId, mode);
        if (still === null || !still()) continue;
        if (removeRunTempDir(tmpRoot, runId, this.#deps.uid)) {
          removed.push(runTempDir(tmpRoot, runId));
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

  /** Null when the directory stays; else the check to make right before removing it. */
  async #removable(
    database: StateDatabase,
    runId: string,
    mode: RunTempSweep,
  ): Promise<StillRemovable | null> {
    const connection = database.connection;
    const row = connection.get<{ office_id: string }>(
      "select office_id from runs where run_id = $run limit 1",
      { run: runId },
    );
    if (row !== null) {
      return this.#endedRun(database.office(row.office_id as OfficeId), runId as RunId);
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
    if (live !== null) return live === 0 ? () => unknown() && claimed() === 0 : null;
    if (mode !== "recovery") return null;
    // A run no database row names: only when this daemon's database made it.
    const owner = this.owner();
    if (owner === undefined) return null;
    if (readRunTempOwner(runTempDir(this.#deps.tmpRoot, runId)) !== owner) return null;
    return () => unknown() && claimed() === null;
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
 * `port` with `after` called once each exit or lost host is decided: the run may have ended
 * there, after its worker exited (DIPO-102).
 */
export function afterRunExits(port: RunOutcomesPort, after: () => void): RunOutcomesPort {
  const wrapped: RunOutcomesPort = {
    onTurnProblem: (view, problem) => port.onTurnProblem(view, problem),
    onPlanLimit: (view, limit) => port.onPlanLimit(view, limit),
    onModelSwitched: (view, model) => port.onModelSwitched(view, model),
    answered: (view) => port.answered(view),
    onExit: async (exit) => {
      try {
        await port.onExit(exit);
      } finally {
        after();
      }
    },
  };
  return {
    ...wrapped,
    ...(port.onPlanWarning === undefined
      ? {}
      : { onPlanWarning: (view, warning) => port.onPlanWarning?.(view, warning) }),
    ...(port.onHostLost === undefined
      ? {}
      : {
          onHostLost: async (lost) => {
            try {
              await port.onHostLost?.(lost);
            } finally {
              after();
            }
          },
        }),
  };
}
