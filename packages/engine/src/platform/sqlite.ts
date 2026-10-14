// The platform SQLite module (0007 sections 1, 2 and 10): the only engine code that touches
// `bun:sqlite`. It opens the one connection to `<state>/dipo.db` with the 0007 pragmas and file
// modes, refuses a `<state>` on a network filesystem, and runs `VACUUM INTO` in a Bun Worker so a
// snapshot never blocks the daemon's one JS thread.

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The logger the module writes to; the daemon's log setup (DIPO-23) passes its own. */
export interface DbLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
/** Named parameters; a key `name` binds `$name` in the SQL (`strict: true`). */
export type SqlParams = Readonly<Record<string, SqlValue>>;
export type SqlRow = Record<string, SqlValue>;

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/** The statement surface shared by the connection, office handles and migration steps. */
export interface SqlRunner {
  run(sql: string, params?: SqlParams): RunResult;
  get<T = SqlRow>(sql: string, params?: SqlParams): T | null;
  all<T = SqlRow>(sql: string, params?: SqlParams): T[];
}

/** The daemon's one connection (0007 section 1). */
export interface SqliteConnection extends SqlRunner {
  /** Absolute path of `dipo.db`. */
  readonly path: string;
  /** Result of `select sqlite_version()` at open. */
  readonly sqliteVersion: string;
  /** True when this open created the file. */
  readonly created: boolean;
  /** Runs one or more statements without parameters (migration steps). */
  exec(sql: string): void;
  /** Runs `fn` in a `BEGIN IMMEDIATE` transaction; every write goes through here. */
  immediate<T>(fn: () => T): T;
  /** Runs `fn` in a deferred transaction, for reads that must match one point in time. */
  deferred<T>(fn: () => T): T;
  /** Closes the connection and throws if a statement is still open (`close(true)`). */
  close(): void;
}

/** One line of the mount table: where a filesystem is mounted and its type. */
export interface MountEntry {
  readonly mountPoint: string;
  readonly fsType: string;
}

/** Reads the mount table, or returns null where the platform has no supported source. */
export type MountReader = () => Promise<readonly MountEntry[] | null>;

export interface OpenSqliteOptions {
  /** The software state directory `<state>` (0006); created with mode 0700 when missing. */
  readonly stateDir: string;
  readonly logger: DbLogger;
  /** Replaces the system mount table, for tests. */
  readonly readMounts?: MountReader;
  /** Run `PRAGMA quick_check` at open, as the daemon does after an unclean exit (0007 section 10). */
  readonly checkIntegrity?: boolean;
}

export const DATABASE_FILE = "dipo.db";
export const BACKUPS_DIR = "backups";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Thrown when `<state>` sits on a network filesystem (0007 section 1). */
export class NetworkFileSystemError extends Error {
  constructor(
    readonly path: string,
    readonly fsType: string,
  ) {
    super(
      `The state directory ${path} is on a network filesystem (${fsType}). SQLite WAL needs a local disk; set DIPO_HOME to a local directory.`,
    );
    this.name = "NetworkFileSystemError";
  }
}

/** Thrown when `PRAGMA quick_check` reports damage (0007 section 10). */
export class IntegrityCheckError extends Error {
  constructor(
    readonly path: string,
    readonly problems: readonly string[],
  ) {
    super(
      `${path} failed its integrity check: ${problems.slice(0, 3).join("; ")}. Restore the newest file in ${join(dirname(path), BACKUPS_DIR)}.`,
    );
    this.name = "IntegrityCheckError";
  }
}

/** Thrown when a transaction callback returns a promise or other thenable. */
export class AsyncTransactionError extends TypeError {
  constructor() {
    super(
      "A transaction callback returned a promise and was rolled back. Callbacks must be synchronous: an await inside one would let other offices' writes interleave (0007 section 1).",
    );
    this.name = "AsyncTransactionError";
  }
}

// Filesystem types that are remote from this machine's point of view.
const NETWORK_FS_TYPES = new Set([
  "nfs",
  "nfs4",
  "smbfs",
  "smb3",
  "cifs",
  "afpfs",
  "webdav",
  "davfs",
  "ncpfs",
  "9p",
  "ceph",
  "glusterfs",
  "lustre",
  "afs",
  "gpfs",
  "sshfs",
  "fuse.sshfs",
  "fuse.rclone",
  "fuse.glusterfs",
  "fuse.cephfs",
]);

/** True for a filesystem type that lives on another machine. */
export function isNetworkFsType(fsType: string): boolean {
  return NETWORK_FS_TYPES.has(fsType.toLowerCase());
}

/**
 * Parses macOS `mount` output, one line per mount:
 * `//user@host/share on /Volumes/share (smbfs, nodev, nosuid, mounted by user)`.
 */
export function parseMountOutput(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^.*? on (.+) \(([^,()]+)(?:,[^()]*)?\)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries.push({ mountPoint: match[1], fsType: match[2].trim() });
    }
  }
  return entries;
}

// mountinfo escapes space, tab, newline and backslash as three octal digits.
const unescapeMountinfo = (field: string) =>
  field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );

/**
 * Parses Linux `/proc/self/mountinfo`, one line per mount:
 * `36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue`.
 * Field 5 is the mount point; the first field after the ` - ` separator is the type.
 */
export function parseMountInfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    const mountPoint = before[4];
    const fsType = after[0];
    if (mountPoint !== undefined && fsType !== undefined && fsType !== "") {
      entries.push({ mountPoint: unescapeMountinfo(mountPoint), fsType });
    }
  }
  return entries;
}

/** The mount that holds `path`: the entry with the longest mount point that prefixes it. */
export function mountFor(path: string, mounts: readonly MountEntry[]): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const entry of mounts) {
    const point = entry.mountPoint;
    const holds =
      point === "/" || path === point || path.startsWith(point.endsWith("/") ? point : `${point}/`);
    if (holds && (best === undefined || point.length >= best.mountPoint.length)) best = entry;
  }
  return best;
}

/** Reads the system mount table: `mount` on macOS, `/proc/self/mountinfo` on Linux. */
export const readSystemMounts: MountReader = async () => {
  if (process.platform === "linux") {
    return parseMountInfo(await readFile("/proc/self/mountinfo", "utf8"));
  }
  if (process.platform === "darwin") {
    const child = Bun.spawn({ cmd: ["/sbin/mount"], stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`/sbin/mount exited with code ${code}`);
    return parseMountOutput(text);
  }
  return null;
};

// Sync clients may copy `dipo.db` without its `-wal` file (0007 section 1).
const SYNC_FOLDER =
  /\/(Library\/Mobile Documents|Library\/CloudStorage|Dropbox|OneDrive|Google Drive)(\/|$)/;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Wraps a transaction callback so a returned thenable throws inside the transaction. */
function synchronousOnly<T>(fn: () => T): () => T {
  return () => {
    const result = fn();
    if (isThenable(result)) {
      // The rollback is what matters; keep a later rejection from going unhandled.
      result.then(undefined, () => undefined);
      throw new AsyncTransactionError();
    }
    return result;
  };
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  chmodSync(path, DIR_MODE);
}

/**
 * Opens `<state>/dipo.db` (0007 section 1). Creates `<state>` with mode 0700 and the file with
 * mode 0600 (SQLite gives the `-wal` and `-shm` files the database file's mode), refuses a
 * network filesystem, sets the pragmas and logs `sqlite_version()`.
 */
export async function openSqlite(options: OpenSqliteOptions): Promise<SqliteConnection> {
  const { logger } = options;
  ensureDir(options.stateDir);
  const stateDir = realpathSync(options.stateDir);

  const mounts = await (options.readMounts ?? readSystemMounts)();
  const mount = mounts === null ? undefined : mountFor(stateDir, mounts);
  if (mount !== undefined && isNetworkFsType(mount.fsType)) {
    throw new NetworkFileSystemError(stateDir, mount.fsType);
  }
  if (SYNC_FOLDER.test(stateDir)) {
    logger.warn("state directory is inside a sync folder; a synced copy can break dipo.db", {
      path: stateDir,
    });
  }

  const path = join(stateDir, DATABASE_FILE);
  const created = !existsSync(path);
  if (created) writeFileSync(path, "", { mode: FILE_MODE, flag: "wx" });
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file) && (statSync(file).mode & 0o777) !== FILE_MODE) chmodSync(file, FILE_MODE);
  }

  const db = new Database(path, { create: true, readwrite: true, strict: true });
  try {
    const one = <T>(sql: string) => db.query(sql).get() as T | null;
    // auto_vacuum only takes effect before the first table exists.
    const tables = one<{ n: number }>("select count(*) as n from sqlite_schema")?.n ?? 0;
    if (tables === 0) db.run("pragma auto_vacuum = INCREMENTAL");
    const mode = one<{ journal_mode: string }>("pragma journal_mode = WAL")?.journal_mode;
    if (mode !== "wal") throw new Error(`${path} could not switch to WAL (journal_mode ${mode})`);
    db.run("pragma synchronous = FULL");
    db.run("pragma foreign_keys = ON");
    db.run("pragma busy_timeout = 5000");
    db.run("pragma journal_size_limit = 67108864");

    const sqliteVersion = one<{ v: string }>("select sqlite_version() as v")?.v ?? "unknown";
    logger.info("opened state database", { path, sqliteVersion, created });

    if (options.checkIntegrity === true) {
      const problems = quickCheck(db);
      if (problems.length > 0) throw new IntegrityCheckError(path, problems);
    }

    return createConnection(db, path, sqliteVersion, created);
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The problems `PRAGMA quick_check` reports; empty for an intact file. */
function quickCheck(db: Database): string[] {
  const lines = db
    .query("pragma quick_check")
    .all()
    .flatMap((row) => String(Object.values(row as SqlRow)[0]).split("\n"));
  return lines.length === 1 && lines[0] === "ok" ? [] : lines;
}

/** A connection to one database file outside the daemon, for offline maintenance (restore). */
export interface SqliteFile extends SqliteConnection {
  /** The problems `PRAGMA quick_check` reports; empty for an intact file. */
  quickCheck(): string[];
}

/**
 * Opens an existing database file read-write in rollback-journal mode, so no `-wal` or `-shm`
 * file appears next to it, with foreign keys on. `dipo restore` (0007 section 10) checks and
 * prepares a copy of a backup through it before the copy replaces `dipo.db`; the daemon switches
 * the file back to WAL at its next open. Throws when the file is not a database.
 */
export function openSqliteFile(path: string): SqliteFile {
  const db = new Database(path, { readwrite: true, create: false, strict: true });
  try {
    const one = <T>(sql: string) => db.query(sql).get() as T | null;
    const mode = one<{ journal_mode: string }>("pragma journal_mode = DELETE")?.journal_mode;
    if (mode !== "delete") throw new Error(`${path} could not leave WAL (journal_mode ${mode})`);
    db.run("pragma synchronous = FULL");
    db.run("pragma foreign_keys = ON");
    const sqliteVersion = one<{ v: string }>("select sqlite_version() as v")?.v ?? "unknown";
    return {
      ...createConnection(db, path, sqliteVersion, false),
      quickCheck: () => quickCheck(db),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function createConnection(
  db: Database,
  path: string,
  sqliteVersion: string,
  created: boolean,
): SqliteConnection {
  return {
    path,
    sqliteVersion,
    created,
    run: (sql, params = {}) => {
      const result = db.query(sql).run(params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    get: <T>(sql: string, params: SqlParams = {}) => db.query(sql).get(params) as T | null,
    all: <T>(sql: string, params: SqlParams = {}) => db.query(sql).all(params) as T[],
    exec: (sql) => {
      db.run(sql);
    },
    immediate: (fn) => db.transaction(synchronousOnly(fn)).immediate(),
    deferred: (fn) => db.transaction(synchronousOnly(fn)).deferred(),
    close: () => db.close(true),
  };
}

/**
 * Path of `sqlite-worker.ts` inside a compiled binary. `scripts/build.ts` passes it to
 * `bun build --compile` as an extra entrypoint with `--root=packages` (DIPO-17).
 */
export const COMPILED_SQLITE_WORKER_PATH = "/$bunfs/root/engine/src/platform/sqlite-worker.ts";

export function sqliteWorkerUrl(moduleUrl: string = import.meta.url): string {
  // In the binary every module is bundled into the entry, so a URL relative to this module would
  // point next to the entry instead of at the worker.
  if (new URL(moduleUrl).pathname.startsWith("/$bunfs/")) return COMPILED_SQLITE_WORKER_PATH;
  return new URL("./sqlite-worker.ts", moduleUrl).href;
}

/** Message to and from `sqlite-worker.ts`. */
export interface VacuumRequest {
  readonly source: string;
  readonly target: string;
  readonly quickCheck: boolean;
}
export type VacuumReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Writes a consistent snapshot of `source` to `target` with `VACUUM INTO`, on a read-only
 * connection in a Bun Worker so the daemon thread is not blocked (0007 section 10). The target's
 * directory is created with mode 0700 and the copy gets mode 0600. With `quickCheck`, the
 * Worker also runs `PRAGMA quick_check` on the copy.
 */
export async function vacuumInto(
  source: string,
  target: string,
  options: { readonly quickCheck?: boolean } = {},
): Promise<void> {
  ensureDir(dirname(target));
  const request: VacuumRequest = { source, target, quickCheck: options.quickCheck === true };
  const worker = new Worker(sqliteWorkerUrl());
  try {
    const reply = await new Promise<VacuumReply>((resolve, reject) => {
      worker.addEventListener("message", (event: MessageEvent<VacuumReply>) => resolve(event.data));
      worker.addEventListener("error", (event) =>
        reject(new Error(`backup worker failed: ${event.message}`)),
      );
      // A Worker has no origin; the empty transfer list is the second argument.
      worker.postMessage(request, []);
    });
    if (!reply.ok) throw new Error(`VACUUM INTO ${target} failed: ${reply.error}`);
  } finally {
    worker.terminate();
  }
  chmodSync(target, FILE_MODE);
}
