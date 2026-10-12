// Forward-only, numbered, checksummed migrations (0007 section 9). They run once for the whole
// file, before any office loads: first a `VACUUM INTO` backup, then each pending step in its own
// immediate transaction that also records the step and moves `PRAGMA user_version`.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Clock } from "@dipsaus-orchestrator/contract";

import {
  BACKUPS_DIR,
  vacuumInto,
  type DbLogger,
  type SqliteConnection,
  type SqlRunner,
} from "../platform/sqlite";

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

/** The database was written by a newer dipo (0007 section 9). */
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
    readonly backup: string,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Migration ${version} failed and was rolled back (${reason}). The pre-migration backup is ${backup}.`,
      { cause },
    );
    this.name = "MigrationFailedError";
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

/** `yyyymmddThhmmss` in UTC, for backup names (0007 section 2). */
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

/**
 * Brings the database to the head of `migrations`. Refuses a database newer than the binary and
 * one whose recorded steps differ from the binary's; writes `backups/pre-v<N>-<time>.db` before
 * applying anything.
 */
export async function migrate(
  db: SqliteConnection,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const { migrations, logger } = options;
  assertMigrationOrder(migrations);
  const head = migrations.length;
  const from = userVersion(db);
  if (from > head) throw new DatabaseTooNewError(from, head);
  verifyApplied(migrations, readApplied(db), from);
  if (from === head) return { from, to: head, backup: null };

  const backup = backupPath(db.path, head, options.clock.now());
  await vacuumInto(db.path, backup);
  logger.info("wrote pre-migration backup", { backup, from, to: head });

  for (const step of migrations.slice(from)) {
    try {
      applyStep(db, step, options);
    } catch (error) {
      logger.warn("migration failed", { version: step.version, name: step.name, backup });
      throw new MigrationFailedError(step.version, backup, error);
    }
    logger.info("applied migration", { version: step.version, name: step.name });
  }
  return { from, to: head, backup };
}
