/**
 * Which catalog revision was last ledgered per (agent, server), so the
 * ledger records CHANGES of the catalog rather than every sighting of
 * it. Module-level on purpose: the isolate outlives the request, and a
 * duplicate row after an isolate restart is harmless, while a row per
 * request was not (the first live wake wrote one per second).
 *
 * The write is single-flighted per pair: concurrent requests in one
 * isolate share the one append in progress rather than each passing
 * a check-before-await, and a revision is remembered only once its
 * append succeeded, so a failed append is retried by the next request.
 */
export class CatalogMemory {
  #seen = new Map<string, string>();
  #inFlight = new Map<string, { revision: string; done: Promise<void> }>();

  /**
   * Write the revision's row through `append` unless it is the one
   * already recorded for the pair. Resolves true when a row was
   * written by this call or by the concurrent call it joined.
   */
  async record(
    agentId: string,
    server: string,
    revision: string,
    append: () => Promise<void>
  ): Promise<boolean> {
    const key = `${agentId}\u0000${server}`;
    if (this.#seen.get(key) === revision) return false;
    const current = this.#inFlight.get(key);
    if (current && current.revision === revision) {
      await current.done;
      return true;
    }
    const done = append().then(() => {
      this.#seen.set(key, revision);
    });
    this.#inFlight.set(key, { revision, done });
    try {
      await done;
      return true;
    } finally {
      if (this.#inFlight.get(key)?.done === done) this.#inFlight.delete(key);
    }
  }
}
