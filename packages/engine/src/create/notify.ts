// What the engine tells about itself while it runs (DIPO-318): which office's change log has new
// entries, so a subscriber catches up. It exists before any service, so a service reaches it from
// its first call.

import type { OfficeId } from "@dipsaus-orchestrator/contract";

/** New entries in an office's change log; every listener hears each office once per notify. */
export class OfficeChanges {
  readonly #listeners = new Set<(office: OfficeId) => void>();

  notify(office: OfficeId): void {
    for (const listener of this.#listeners) listener(office);
  }

  /** Adds a listener; returns the call that removes it. */
  listen(listener: (office: OfficeId) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
