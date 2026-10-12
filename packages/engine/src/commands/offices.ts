// How the executor finds an office. The engine keeps no per-connection state, so every office
// command names its office and nothing ever falls back to a default one (0005 section 3). DIPO-27
// replaces the default directory with its lazy loader of office engine instances.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

import type { StateDatabase } from "../db/database";
import type { OfficeHandle } from "../db/office";

export interface OfficeDirectory {
  /** The handle of a registered, not forgotten office; undefined for any other id. */
  get(office: OfficeId): OfficeHandle | undefined;
}

/** Offices straight from the `offices` table: rows without `forgotten_at` (0007 section 3). */
export function stateOfficeDirectory(state: StateDatabase): OfficeDirectory {
  return {
    get(office) {
      const row = state.connection.get(
        "select 1 as found from offices where office_id = $office and forgotten_at is null",
        { office },
      );
      return row === null ? undefined : state.office(office);
    },
  };
}
