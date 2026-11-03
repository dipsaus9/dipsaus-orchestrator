// Forward-only, numbered, checksummed migrations (0007). They run once for the whole
// file, before any office loads: first a `VACUUM INTO` backup, then each pending step in its own
// immediate transaction that also records the step and moves `PRAGMA user_version`. Then the schema
// must equal the one the same steps build in a fresh in-memory database.

import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";

import {
  BACKUPS_DIR,
  DATABASE_FILE,
  openImmutableSqlite,
  openMemorySqlite,
  vacuumInto,
  type DbLogger,
  type SqliteConnection,
  type SqlRunner,
} from "../platform/sqlite";
import {
  backupsDirectory,
  preMigrationBackups,
  prunePreMigrationBackups,
  removeDailyBackups,
} from "./backup-files";

/** What a TypeScript step may use: statements and multi-statement SQL, inside its transaction. */
export interface MigrationContext extends SqlRunner {
  exec(sql: string): void;
}

interface MigrationBase {
  /** 1, 2, 3, ... with no gaps; never reused or edited once merged. */
  readonly version: number;
  readonly name: string;
}

/** A step written as SQL; the checksum covers the SQL text. */
export interface SqlMigration extends MigrationBase {
  readonly sql: string;
}

/**
 * A step written as code. Function text changes with the bundler, so the checksum covers
 * `source`, a description the author changes whenever `run` changes.
 */
export interface CodeMigration extends MigrationBase {
  readonly run: (db: MigrationContext) => void;
  readonly source: string;
}

export type Migration = SqlMigration | CodeMigration;

/** Recorded in `schema_migrations` for each applied step. */
export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export interface MigrateOptions {
  readonly migrations: readonly Migration[];
  readonly clock: Clock;
  readonly logger: DbLogger;
  /** The binary version written into `schema_migrations.engine_version`. */
  readonly engineVersion: string;
}

export interface MigrateResult {
  readonly from: number;
  readonly to: number;
  /** The pre-migration backup, or null when nothing was pending. */
  readonly backup: string | null;
}

/** The database was written by a newer dipo (0007). */
export class DatabaseTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `The state database is at schema version ${found}, newer than this dipo supports (${supported}). Please upgrade dipo, or restore a pre-migration backup.`,
    );
    this.name = "DatabaseTooNewError";
  }
}

/** The name of the first step a database recorded before the steps were squashed into one base (0007). */
export const PRE_SQUASH_FIRST_STEP = "offices and schema_migrations";

/**
 * The database was written by a dipo from before its migrations were squashed into one base schema
 * (0007). This dipo cannot read it and does not change or delete it: the maintainer moves it away,
 * and the next start creates a fresh database.
 */
export class DatabaseBeforeSquashError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
  ) {
    super(
      `The state database ${path} was written by an earlier dipo, before its schema steps were squashed into one base schema (it is at version ${found}), and this dipo cannot read it. Stop the daemon, move ${path} and its -wal and -shm files away, and start the daemon again: it creates a fresh database. Stories, branches and PRs stay in Backlog.md and git; only run history (costs, logs) is lost.`,
    );
    this.name = "DatabaseBeforeSquashError";
  }
}

/** A recorded step no longer matches the binary's step: someone edited a released migration. */
export class MigrationChecksumError extends Error {
  constructor(
    readonly version: number,
    detail: string,
  ) {
    super(`Migration ${version} does not match the one applied to this database: ${detail}.`);
    this.name = "MigrationChecksumError";
  }
}

/** A step failed and was rolled back; `user_version` is unchanged. */
export class MigrationFailedError extends Error {
  constructor(
    readonly version: number,
    readonly backup: string | null,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const copy =
      backup === null
        ? "No pre-migration backup was written: the database was new and empty."
        : `The pre-migration backup is ${backup}.`;
    super(`Migration ${version} failed and was rolled back (${reason}). ${copy}`, { cause });
    this.name = "MigrationFailedError";
  }
}

/** One table, index, trigger or view of a database (`sqlite_schema`), its SQL with spaces collapsed. */
export interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

/**
 * The database's schema differs from the one its migrations build (DIPO-426): a statement that was
 * skipped, or a change made outside dipo. `objects` names each differing object.
 */
export class SchemaDriftError extends Error {
  constructor(
    readonly objects: readonly string[],
    readonly backup: string | null,
  ) {
    const copy =
      backup === null
        ? "There is no pre-migration backup."
        : `The newest pre-migration backup is ${backup}.`;
    super(
      `The state database's schema differs from the one its migrations build: ${objects.join("; ")}. ${copy}`,
    );
    this.name = "SchemaDriftError";
  }
}

/** sha256 over the step's SQL, or over the declared source of a code step. */
export function migrationChecksum(step: Migration): string {
  const body = "sql" in step ? `sql\n${step.sql}` : `code\n${step.source}`;
  return createHash("sha256").update(body).digest("hex");
}

/** Throws unless the steps are numbered 1, 2, 3, ... in order. */
export function assertMigrationOrder(migrations: readonly Migration[]): void {
  migrations.forEach((step, index) => {
    if (step.version !== index + 1) {
      throw new Error(
        `Migration "${step.name}" has version ${step.version}; expected ${index + 1} (versions start at 1 with no gaps, in order).`,
      );
    }
  });
}

/** `yyyymmddThhmmss` in UTC, for backup names (0007). */
export function backupStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replaceAll("-", "")
    .replaceAll(":", "");
}

function userVersion(db: SqlRunner): number {
  return db.get<{ user_version: number }>("pragma user_version")?.user_version ?? 0;
}

function readApplied(db: SqlRunner): AppliedMigration[] {
  const table = db.get(
    "select 1 as found from sqlite_schema where type = 'table' and name = $name",
    {
      name: "schema_migrations",
    },
  );
  if (table === null) return [];
  return db.all<AppliedMigration>(
    "select version, name, checksum from schema_migrations order by version",
  );
}

function verifyApplied(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
  current: number,
): void {
  const recorded = new Map(applied.map((row) => [row.version, row]));
  for (let version = 1; version <= current; version++) {
    const step = migrations[version - 1];
    const row = recorded.get(version);
    if (step === undefined) continue; // unreachable: current <= head was checked first
    if (row === undefined) {
      throw new MigrationChecksumError(version, "schema_migrations has no record of it");
    }
    if (row.checksum !== migrationChecksum(step)) {
      throw new MigrationChecksumError(
        version,
        `recorded checksum ${row.checksum.slice(0, 12)} differs from ${migrationChecksum(step).slice(0, 12)} in this binary`,
      );
    }
  }
}

function backupPath(dbPath: string, version: number, ms: number): string {
  const dir = join(dirname(dbPath), BACKUPS_DIR);
  const base = `pre-v${version}-${backupStamp(ms)}`;
  let candidate = join(dir, `${base}.db`);
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${base}-${n}.db`);
  return candidate;
}

/**
 * Whether the database holds a table other than SQLite's own. SQLite reserves the literal
 * `sqlite_` prefix; LIKE would also skip names such as `sqliteXdata` (`_` matches any character).
 */
function holdsUserTables(db: SqlRunner): boolean {
  return (
    db.get(
      "select 1 from sqlite_schema where type = 'table' and substr(name, 1, 7) <> 'sqlite_'",
    ) !== null
  );
}

function applyStep(db: SqliteConnection, step: Migration, options: MigrateOptions): void {
  db.immediate(() => {
    if ("sql" in step) db.exec(step.sql);
    else step.run({ run: db.run, get: db.get, all: db.all, exec: db.exec });
    const violations = db.all("pragma foreign_key_check");
    if (violations.length > 0) {
      throw new Error(`foreign_key_check found ${violations.length} violations`);
    }
    db.run(
      "insert into schema_migrations (version, name, checksum, engine_version, applied_at) values ($version, $name, $checksum, $engine_version, $applied_at)",
      {
        version: step.version,
        name: step.name,
        checksum: migrationChecksum(step),
        engine_version: options.engineVersion,
        applied_at: options.clock.now(),
      },
    );
    // user_version lives in the file header and commits or rolls back with the step.
    db.exec(`pragma user_version = ${step.version}`);
  });
}

/** Every object of the database but SQLite's own (`sqlite_` names, such as `ANALYZE`'s tables). */
export function readSchema(db: SqlRunner): SchemaObject[] {
  return db
    .all<SchemaObject>(
      "select type, name, sql from sqlite_schema where substr(name, 1, 7) <> 'sqlite_' order by type, name",
    )
    .map((row) => ({ ...row, sql: row.sql === null ? null : row.sql.replace(/\s+/g, " ").trim() }));
}

// Built once per list of steps, so a daemon start pays for it once.
const builtSchemas = new Map<string, readonly SchemaObject[]>();

/** The schema `migrations` build in a fresh in-memory database. */
export function migratedSchema(
  migrations: readonly Migration[],
  options: MigrateOptions,
): readonly SchemaObject[] {
  const key = migrations.map(migrationChecksum).join(" ");
  const known = builtSchemas.get(key);
  if (known !== undefined) return known;
  const memory = openMemorySqlite();
  try {
    for (const step of migrations) applyStep(memory, step, options);
    const schema = readSchema(memory);
    builtSchemas.set(key, schema);
    return schema;
  } finally {
    memory.close();
  }
}

/** What differs between the live schema and the built one, one entry per object. */
export function schemaDifferences(
  live: readonly SchemaObject[],
  built: readonly SchemaObject[],
): string[] {
  const key = (object: SchemaObject) => `${object.type} ${object.name}`;
  const expected = new Map(built.map((object) => [key(object), object]));
  const found = new Map(live.map((object) => [key(object), object]));
  const differences: string[] = [];
  for (const [name, object] of expected) {
    const have = found.get(name);
    if (have === undefined) differences.push(`${name} is missing`);
    else if (have.sql !== object.sql) differences.push(`${name} has different SQL`);
  }
  for (const name of found.keys()) {
    if (!expected.has(name)) differences.push(`${name} is not built by the migrations`);
  }
  return differences;
}

/** Throws `SchemaDriftError` unless the live schema equals the one the migrations build. */
function verifySchema(db: SqliteConnection, options: MigrateOptions, backup: string | null): void {
  const differences = schemaDifferences(
    readSchema(db),
    migratedSchema(options.migrations, options),
  );
  if (differences.length === 0) return;
  const dir = backupsDirectory(db.path);
  const newest = backup ?? preMigrationBackups(dir)[0];
  throw new SchemaDriftError(
    differences,
    newest === undefined ? null : join(dir, basename(newest)),
  );
}

/**
 * Deletes the daily copies an earlier dipo wrote, once this dipo opened the database: a refused or
 * failed open leaves them for the maintainer (0007).
 */
function removeOldDailyBackups(db: SqliteConnection, logger: DbLogger): void {
  const removed = removeDailyBackups(join(dirname(db.path), BACKUPS_DIR));
  if (removed.length > 0) logger.info("removed daily backups", { removed });
}

/**
 * Refuses `<stateDir>/dipo.db` when an earlier dipo wrote it before the squash
 * (`DatabaseBeforeSquashError`), before `openSqlite` touches it: the look goes through an immutable
 * read-only open, so a refused file gets no new `-wal` or `-shm` next to it. A missing, empty or
 * unreadable file passes: the open and the migrations say what is wrong with it.
 */
export function refuseBeforeSquash(stateDir: string): void {
  let path: string;
  try {
    path = join(realpathSync(stateDir), DATABASE_FILE);
    if (statSync(path).size === 0) return;
  } catch {
    return;
  }
  let found: { readonly beforeSquash: boolean; readonly version: number };
  try {
    const db = openImmutableSqlite(path);
    try {
      found = {
        beforeSquash: readApplied(db).some(
          (row) => row.version === 1 && row.name === PRE_SQUASH_FIRST_STEP,
        ),
        version: userVersion(db),
      };
    } finally {
      db.close();
    }
  } catch {
    return;
  }
  if (found.beforeSquash) throw new DatabaseBeforeSquashError(path, found.version);
}

/**
 * Brings the database to the head of `migrations`. Refuses a database newer than the binary and
 * one whose recorded steps differ from the binary's; writes `backups/pre-v<N>-<time>.db` before
 * applying anything. Then refuses a database whose schema differs from the one the steps build
 * (`SchemaDriftError`). A new database (version 0, no user tables) has nothing to copy, so it gets no
 * backup and `backup` is null.
 */
export async function migrate(
  db: SqliteConnection,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const { migrations, logger } = options;
  assertMigrationOrder(migrations);
  const head = migrations.length;
  const from = userVersion(db);
  const applied = readApplied(db);
  if (from > head) throw new DatabaseTooNewError(from, head);
  verifyApplied(migrations, applied, from);
  if (from === head) {
    verifySchema(db, options, null);
    removeOldDailyBackups(db, logger);
    return { from, to: head, backup: null };
  }

  const fresh = from === 0 && !holdsUserTables(db);
  const backup = fresh ? null : backupPath(db.path, head, options.clock.now());
  if (backup !== null) {
    await vacuumInto(db.path, backup);
    // The only backup (0007): the two newest copies are kept.
    const removed = prunePreMigrationBackups(dirname(backup), new Set([basename(backup)]));
    logger.info("wrote pre-migration backup", { backup, from, to: head, removed });
  }

  for (const step of migrations.slice(from)) {
    try {
      applyStep(db, step, options);
    } catch (error) {
      logger.warn("migration failed", { version: step.version, name: step.name, backup });
      throw new MigrationFailedError(step.version, backup, error);
    }
    logger.info("applied migration", { version: step.version, name: step.name });
  }
  verifySchema(db, options, backup);
  removeOldDailyBackups(db, logger);
  return { from, to: head, backup };
}
