// The office git queue (0010 sections 2a and 7): one per office, serialising refs, worktrees and
// pushes. An item runs alone, from its first git step to its last, so work that must not
// interleave (a pickup re-check with its claim, a journaled lane-b operation with its live-claim
// check) is one item. Items run in submission order; a failed item ends only itself.

export class GitQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  /** Items submitted and not yet finished, the running one included. */
  get pending(): number {
    return this.#pending;
  }

  /** Runs `item` after every item submitted before it has finished; resolves with its result. */
  run<T>(item: () => Promise<T>): Promise<T> {
    this.#pending += 1;
    const start = (): Promise<T> => item();
    const result = this.#tail.then(start, start).finally(() => {
      this.#pending -= 1;
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
