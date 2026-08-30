import { DurableObject } from "cloudflare:workers";

/**
 * The till's shared MPP store (operon#67, certified by
 * cairnwake.com/r/ea57e4fe): mppx's charge method rejects replayed
 * credentials by claiming the settlement hash in its store, but the
 * till passed no store, so mppx fell back to a PER-ISOLATE memory
 * store and a replay landing on another isolate re-verified the same
 * on-chain transaction and served a 200. One Durable Object makes the
 * claim set colony-wide: a replay now answers 402 invalid-challenge
 * (already-used) from every isolate. mppx's own docs require exactly
 * this ("use a shared store in multi-instance deployments").
 */
export class TillStore extends DurableObject {
  async get(key: string): Promise<unknown> {
    return (await this.ctx.storage.get(`kv:${key}`)) ?? null;
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(`kv:${key}`, value);
  }

  async delete(key: string): Promise<void> {
    await this.ctx.storage.delete(`kv:${key}`);
  }

  /**
   * mppx's replay-claim fast path: record first use of a key through
   * its expiry, atomically (the DO serializes). True means this call
   * claimed it; false means it was already claimed and unexpired.
   */
  async tryClaim(key: string, expires: number): Promise<boolean> {
    const existing = await this.ctx.storage.get<number>(`claim:${key}`);
    if (existing !== undefined && existing > Date.now()) return false;
    await this.ctx.storage.put(`claim:${key}`, expires);
    return true;
  }

  /** Versioned read for the optimistic update loop in the adapter. */
  async getVersioned(key: string): Promise<{ value: unknown; version: number }> {
    const row = await this.ctx.storage.get<{ value: unknown; version: number }>(`v:${key}`);
    return row ?? { value: null, version: 0 };
  }

  /** Compare-and-swap write; false means the version moved, retry. */
  async casPut(
    key: string,
    expectedVersion: number,
    change: { op: "noop" } | { op: "set"; value: unknown } | { op: "delete" }
  ): Promise<boolean> {
    const row = await this.ctx.storage.get<{ value: unknown; version: number }>(`v:${key}`);
    const version = row?.version ?? 0;
    if (version !== expectedVersion) return false;
    if (change.op === "set") {
      await this.ctx.storage.put(`v:${key}`, { value: change.value, version: version + 1 });
    } else if (change.op === "delete") {
      await this.ctx.storage.delete(`v:${key}`);
    }
    return true;
  }
}

export { durableStore, type TillStoreStub } from "./store-adapter.js";
