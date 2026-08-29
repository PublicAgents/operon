import { DurableObject } from "cloudflare:workers";
import { withinOfferCap, type Offer } from "./gates.js";

/**
 * One TillCatalog Durable Object per colony: the offer catalog, keyed by
 * host and path so serving lookups are exact. Validation happens in the
 * Worker (it holds the roster and ceilings); the DO stores and serializes.
 */
export class TillCatalog extends DurableObject {
  private key(host: string, path: string): string {
    return `offer:${host}:${path}`;
  }

  /**
   * Count-and-put in one serialized DO turn, so overlapping offer requests
   * cannot both pass the cap (the read-then-write version raced).
   */
  async putCapped(offer: Offer, maxOffers: number): Promise<{ ok: boolean }> {
    const all = [...(await this.ctx.storage.list<Offer>({ prefix: "offer:" })).values()];
    if (!withinOfferCap(all, offer, maxOffers)) return { ok: false };
    await this.ctx.storage.put(this.key(offer.host, offer.path), offer);
    return { ok: true };
  }

  async get(host: string, path: string): Promise<Offer | undefined> {
    return this.ctx.storage.get<Offer>(this.key(host, path));
  }

  /** Delete an offer; only the owning agent's retire reaches this. */
  async retire(host: string, path: string): Promise<boolean> {
    return this.ctx.storage.delete(this.key(host, path));
  }

  async listForAgent(agentId: string): Promise<Offer[]> {
    const all = await this.ctx.storage.list<Offer>({ prefix: "offer:" });
    return [...all.values()].filter(offer => offer.agentId === agentId);
  }

  /** Every live offer across agents (the operator's till view). */
  async listAll(): Promise<Offer[]> {
    const all = await this.ctx.storage.list<Offer>({ prefix: "offer:" });
    return [...all.values()];
  }
}
