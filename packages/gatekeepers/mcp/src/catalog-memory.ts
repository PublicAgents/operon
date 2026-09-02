/**
 * Which catalog revision was last ledgered per (agent, server), so the
 * ledger records CHANGES of the catalog rather than every sighting of
 * it. Module-level on purpose: the isolate outlives the request, and a
 * duplicate row after an isolate restart is harmless, while a row per
 * request was not (the first live wake wrote one per second).
 */
export class CatalogMemory {
  #seen = new Map<string, string>();

  /** True when this revision differs from the last one noted for the pair. */
  changed(agentId: string, server: string, revision: string): boolean {
    const key = `${agentId}\u0000${server}`;
    if (this.#seen.get(key) === revision) return false;
    this.#seen.set(key, revision);
    return true;
  }
}
