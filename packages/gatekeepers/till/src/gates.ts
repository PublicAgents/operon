import type { Roster, RosterAgent } from "@operon/core";

/**
 * Pure till policy: offer validation against colony ceilings, host
 * ownership, and path rules; and hostname resolution for an agent's
 * assigned hosts. The agent prices its own work; the CEILINGS come from
 * colony config it cannot write (spec 0002 §2.1).
 */

export interface Offer {
  agentId: string;
  host: string;
  path: string;
  /** Decimal display value as a string, e.g. "0.05". */
  price: string;
  currency: string;
  description: string;
}

export interface OfferLimits {
  /** Maximum price per offer (decimal string). */
  maxPrice: string;
  /** Maximum simultaneous offers per agent. */
  maxOffers: number;
  /** The currencies (token addresses / method identifiers) colony allows. */
  currencies: string[];
}

/** The concrete hostnames an agent's roster hosts resolve to. */
export function agentHostnames(agent: RosterAgent, zone: string): string[] {
  return agent.hosts.map(host => (host === "@" ? zone : `${host}.${zone}`));
}

const PATH_RE = /^\/[A-Za-z0-9._/-]*$/;
const PRICE_RE = /^\d+(\.\d{1,6})?$/;

export type OfferProblem =
  | "invalid_path"
  | "reserved_path"
  | "host_not_assigned"
  | "invalid_price"
  | "price_above_ceiling"
  | "currency_not_allowed"
  | "missing_description"
  | "too_many_offers";

/**
 * Validate one offer's shape and ceilings. The OFFER-COUNT cap is not
 * checked here: it must be enforced inside the catalog DO's single
 * serialized turn (withinOfferCap), or two overlapping requests both pass
 * a read-then-write check.
 */
export function validateOffer(
  offer: Omit<Offer, "agentId">,
  agent: RosterAgent,
  roster: Roster,
  limits: OfferLimits
): OfferProblem | null {
  if (!PATH_RE.test(offer.path) || offer.path.includes("..") || offer.path.includes("//")) {
    return "invalid_path";
  }
  // The chassis' own surfaces must never be sellable or shadowed.
  if (offer.path === "/gatekeeper" || offer.path.startsWith("/gatekeeper/")) {
    return "reserved_path";
  }
  if (!agentHostnames(agent, roster.zone).includes(offer.host)) {
    return "host_not_assigned";
  }
  if (!PRICE_RE.test(offer.price)) return "invalid_price";
  if (comparePrices(offer.price, limits.maxPrice) > 0) return "price_above_ceiling";
  if (!limits.currencies.includes(offer.currency)) return "currency_not_allowed";
  if (!offer.description || offer.description.length > 200) return "missing_description";
  return null;
}

/**
 * The cap decision the catalog DO makes atomically: an update to the same
 * host+path is not a new slot; only OTHER offers count.
 */
export function withinOfferCap(existing: Offer[], candidate: Offer, maxOffers: number): boolean {
  const others = existing.filter(
    offer =>
      offer.agentId === candidate.agentId &&
      !(offer.host === candidate.host && offer.path === candidate.path)
  );
  return others.length < maxOffers;
}

/** Compare two decimal price strings without floating point. */
export function comparePrices(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const width = Math.max(af.length, bf.length);
  const an = BigInt(ai + af.padEnd(width, "0"));
  const bn = BigInt(bi + bf.padEnd(width, "0"));
  return an === bn ? 0 : an > bn ? 1 : -1;
}

/**
 * Money bearers are per-agent (spec 0002 §3): the environment holds one
 * secret per agent (TILL_TOKEN_<AGENTID>), and identity derives from
 * WHICH bearer matched, never from a payload claim.
 */
export function tokenEnvName(agentId: string): string {
  return `TILL_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
}
