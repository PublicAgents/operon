/**
 * Which catalog revision was last ledgered per (agent, server), so the
 * ledger records CHANGES of the catalog rather than every sighting of
 * it. Module-level on purpose: the isolate outlives the request, and a
 * duplicate row after an isolate restart is harmless, while a row per
 * request was not (the first live wake wrote one per second).
 *
 * Two steps, not one: a revision is asked about before the append and
 * noted only AFTER the append succeeded, so a failed append leaves the
 * revision unrecorded here and the next request tries again.
 */
export class CatalogMemory {
  #seen = new Map<string, string>();

  /** True when this revision differs from the last one NOTED for the pair. */
  isNew(agentId: string, server: string, revision: string): boolean {
    return this.#seen.get(this.#key(agentId, server)) !== revision;
  }

  /** Call once the revision's ledger row has been written. */
  note(agentId: string, server: string, revision: string): void {
    this.#seen.set(this.#key(agentId, server), revision);
  }

  #key(agentId: string, server: string): string {
    return `${agentId}\u0000${server}`;
  }
}
