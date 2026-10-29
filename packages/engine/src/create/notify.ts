// What the engine tells about itself while it runs (DIPO-318): which office's change log has new
// entries, so a subscriber catches up, and whether a TUI is connected, which the socket server
// knows and the live questions ask (0021, DIPO-279). Both exist before any service, so a service
// reaches them from its first call.

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

/** Whether a TUI is connected right now, as the socket server last said, and who hears a change. */
export class TuiPresence {
  #connected = false;
  readonly #listeners = new Set<() => void>();

  tuiConnected(): boolean {
    return this.#connected;
  }

  /** Records what the server sees; a change goes to every listener. */
  set(connected: boolean): void {
    if (connected === this.#connected) return;
    this.#connected = connected;
    for (const listener of this.#listeners) listener();
  }

  /** Adds a listener for each change; returns the call that removes it. */
  listen(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
