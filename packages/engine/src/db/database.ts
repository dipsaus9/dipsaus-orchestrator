// The central state database (0007): open `<state>/dipo.db`, migrate it to the binary's head,
// import the pricing catalogs it lacks, and hand each office a handle bound to its `office_id`.

import type { Clock, OfficeId } from "@dipsaus-orchestrator/contract";

import { openSqlite, type OpenSqliteOptions, type SqliteConnection } from "../platform/sqlite";
import { CATALOGS, type ShippedCatalog } from "../pricing/catalog";
import type { PriceBook } from "../pricing/estimate";
import { importCatalogs, loadPriceBook } from "../pricing/import";

import { migrate, type MigrateResult, type Migration } from "./migrations";
import { OfficeHandle } from "./office";
import { MIGRATIONS } from "./schema";

export interface OpenStateDatabaseOptions extends OpenSqliteOptions {
  readonly clock: Clock;
  /** The binary version, recorded with each applied migration. */
  readonly engineVersion: string;
  /** Replaces the compiled-in migrations, for tests. */
  readonly migrations?: readonly Migration[];
  /**
   * Replaces the shipped pricing catalogs, for tests; null skips the import. Defaults to the
   * shipped catalogs, or to null when `migrations` is replaced (the pricing tables may be absent).
   */
  readonly catalogs?: readonly ShippedCatalog[] | null;
}

export interface StateDatabase {
  /** The one connection; software-level code (office list, migrations) uses it directly. */
  readonly connection: SqliteConnection;
  readonly migration: MigrateResult;
  /** The newest imported pricing catalog, or null when none is imported. */
  readonly pricing: PriceBook | null;
  /** A handle for one office's engine instance. */
  office(officeId: OfficeId): OfficeHandle;
  close(): void;
}

/**
 * Opens and migrates the state database, then imports every shipped pricing catalog it lacks.
 * Throws when the file cannot be used: network filesystem, failed integrity check, a newer
 * schema, an edited migration or a failed step, or an edited pricing catalog.
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
    const catalogs =
      options.catalogs === undefined
        ? options.migrations === undefined
          ? CATALOGS
          : null
        : options.catalogs;
    let pricing: PriceBook | null = null;
    if (catalogs !== null) {
      const { imported } = importCatalogs(connection, options.clock, catalogs);
      if (imported.length > 0) options.logger.info("imported pricing catalogs", { imported });
      pricing = loadPriceBook(connection);
    }
    return {
      connection,
      migration,
      pricing,
      office: (officeId) => new OfficeHandle(connection, officeId),
      close: () => connection.close(),
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
