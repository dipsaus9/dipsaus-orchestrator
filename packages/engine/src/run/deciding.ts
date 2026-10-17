// The deciding guard of worker outcomes (DIPO-51; one helper since DIPO-128): the decisions being
// made now, each under a key that starts with its run id. A restart step and a plan-limit or park
// resume leave the run of a decision under way alone, and an exit already being decided is not
// decided twice.

export class DecidingGuard {
  readonly #keys = new Set<string>();

  /** True while this exact decision is under way. */
  has(key: string): boolean {
    return this.#keys.has(key);
  }

  /** True while any decision of the run is under way. */
  busy(runId: string): boolean {
    return [...this.#keys].some((key) => key.startsWith(`${runId} `));
  }

  /**
   * Runs `work` as the decision `key`: the key is held from this call (before any await) until
   * `work` settles, whether it resolves or throws.
   */
  async within<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.#keys.add(key);
    try {
      return await work();
    } finally {
      this.#keys.delete(key);
    }
  }
}
