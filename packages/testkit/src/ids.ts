// Deterministic ids for tests: `run-0001`, `run-0002`, `agt-0001` (0017 section 4).

import type { IdPrefix, IdSource } from "@dipsaus-orchestrator/contract";

export class SequentialIds implements IdSource {
  #counters = new Map<IdPrefix, number>();

  next(prefix: IdPrefix): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, "0")}`;
  }
}
