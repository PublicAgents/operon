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
  /** The most recently STARTED write per pair, so a slower, older one cannot overwrite a newer memory. */
  #latest = new Map<string, number>();
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
    this.#latest.set(key, started);
    const done = append().then(
      () => {
        // Remember only if no later write for this pair began meanwhile
        // (or the later one failed and withdrew): the ledger holds both
        // rows in order, and the memory must hold the newest persisted,
        // not whichever append happened to finish last.
        const latest = this.#latest.get(key);
        if (latest === started || latest === undefined) this.#seen.set(key, revision);
      },
      error => {
        // A failed write withdraws its claim to being the latest, so an
        // older write still in flight can be remembered when it lands,
        // rather than appended again on its next sighting.
        if (this.#latest.get(key) === started) this.#latest.delete(key);
        throw error;
      }
    );
    this.#inFlight.set(flightKey, done);
    try {
      await done;
      return true;
    } finally {
      this.#inFlight.delete(flightKey);
    }
  }
}
