// The central state database (0007): open `<state>/dipo.db`, migrate it to the binary's head, and
// hand each office a handle bound to its `office_id`.

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import { openSqlite, type OpenSqliteOptions, type SqliteConnection } from "../platform/sqlite";

import { migrate, type MigrateResult, type Migration } from "./migrations";
import { OfficeHandle } from "./office";
import { MIGRATIONS } from "./schema";

export interface OpenStateDatabaseOptions extends OpenSqliteOptions {
  readonly clock: Clock;
  /** The binary version, recorded with each applied migration. */
  readonly engineVersion: string;
  /** Replaces the compiled-in migrations, for tests. */
  readonly migrations?: readonly Migration[];
}

export interface StateDatabase {
  /** The one connection; software-level code (office list, migrations) uses it directly. */
  readonly connection: SqliteConnection;
  readonly migration: MigrateResult;
  /** A handle for one office's engine instance. */
  office(officeId: OfficeId): OfficeHandle;
  close(): void;
  /**
   * The daemon's exit close (DIPO-87), run on every exit path that reaches the daemon's final
   * cleanup, a clean stop or not: checkpoint (TRUNCATE), then close, leaving no `-wal` or `-shm`
   * file. Never throws; a failure is logged at warn on the database logger.
   */
  shutdown(): void;
}

/**
 * Opens and migrates the state database. Throws when the file cannot be used: network
 * filesystem, failed integrity check, a newer schema, an edited migration or a failed step.
 */
export async function openStateDatabase(options: OpenStateDatabaseOptions): Promise<StateDatabase> {
  const connection = await openSqlite(options);
  try {
    const migration = await migrate(connection, {
      migrations: options.migrations ?? MIGRATIONS,
      clock: options.clock,
      logger: options.logger,
      engineVersion: options.engineVersion,
    });
    return {
      connection,
      migration,
      office: (officeId) => new OfficeHandle(connection, officeId),
      close: () => connection.close(),
      shutdown: () => connection.shutdown(options.logger),
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
