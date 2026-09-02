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
  /** Keyed by pair AND revision: two revisions of one pair in flight at once each keep their own. */
  #inFlight = new Map<string, Promise<void>>();
  /** The start order of the write each memory came from, so an older write landing later cannot regress it. */
  #persisted = new Map<string, number>();
  #sequence = 0;

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
    const flightKey = `${key}\u0000${revision}`;
    const current = this.#inFlight.get(flightKey);
    if (current) {
      await current;
      return true;
    }
    const started = ++this.#sequence;
    const done = append().then(() => {
      // The memory is the revision of the NEWEST write that persisted,
      // in start order: an older write landing after a newer one has
      // persisted is a row the ledger holds in order but not the
      // current catalog, and a failed write persisted nothing, so it
      // neither claims nor blocks anything.
      if ((this.#persisted.get(key) ?? 0) < started) {
        this.#persisted.set(key, started);
        this.#seen.set(key, revision);
      }
    });
    this.#inFlight.set(flightKey, done);
    try {
      await done;
      return true;
    } finally {
      this.#inFlight.delete(flightKey);
    }
  }
}
