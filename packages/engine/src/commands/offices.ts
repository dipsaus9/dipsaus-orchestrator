// How the executor finds an office. The engine keeps no per-connection state, so every office
// command names its office and nothing ever falls back to a default one (0005 section 3). The
// daemon uses the lazy loader of office engine instances (`office/manager.ts`, DIPO-27); tests of
// the executor use the plain directory below.

import { engineError, type EngineError, type OfficeId } from "@dipsaus-orchestrator/contract";

import type { StateDatabase } from "../db/database";
import type { OfficeHandle } from "../db/office";

export type OfficeAccess =
  | { readonly ok: true; readonly office: OfficeHandle }
  | { readonly ok: false; readonly error: EngineError };

export interface OfficeDirectory {
  /**
   * The handle of a registered, not forgotten office whose engine instance is loaded, loading it
   * first when needed; `office.unknown` for any other id, or the reason the office was refused.
   */
  load(office: OfficeId): Promise<OfficeAccess>;
  /** The handle of an office that is already loaded; undefined for any other id. */
  get(office: OfficeId): OfficeHandle | undefined;
}

export function officeUnknown(office: OfficeId): EngineError {
  return engineError("office.unknown", `There is no open office ${office}.`, { office });
}

/** Offices straight from the `offices` table: rows without `forgotten_at` (0007 section 3). */
export function stateOfficeDirectory(state: StateDatabase): OfficeDirectory {
  const get = (office: OfficeId): OfficeHandle | undefined => {
    const row = state.connection.get(
      "select 1 as found from offices where office_id = $office and forgotten_at is null",
      { office },
    );
    return row === null ? undefined : state.office(office);
  };
  return {
    get,
    load: async (office) => {
      const handle = get(office);
      return handle === undefined
        ? { ok: false, error: officeUnknown(office) }
        : { ok: true, office: handle };
    },
  };
}
