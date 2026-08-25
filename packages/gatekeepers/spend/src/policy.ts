/**
 * Pure spend policy (spec 0002 §2.2): SSRF bounds on agent-supplied URLs,
 * merchant-tuple identity, base-unit amount arithmetic, and cap decisions.
 * Everything here is deterministic and unit-tested; the Durable Object
 * provides atomicity, the Worker provides credentials.
 */

export interface MerchantTuple {
  origin: string;
  method: string;
  recipient: string;
}

/** The identity an operator approval binds (origin AND method AND recipient). */
export function tupleKey(tuple: MerchantTuple): string {
  return `${tuple.origin}|${tuple.method}|${tuple.recipient.toLowerCase()}`;
}

export type UrlProblem =
  | "not_https"
  | "ip_literal"
  | "credentials_in_url"
  | "chassis_host"
  | "invalid_url";

/**
 * SSRF bounds for the pay fetch (spec §2.2): https only, no IP literals,
 * no userinfo, and the chassis' own hosts denied by name. Name checks are
 * the outer fence; the wall is that no chassis surface trusts network
 * position and the spend Gatekeeper joins no private network, ever.
 */
export function validatePayUrl(raw: string, chassisZone: string): UrlProblem | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid_url";
  }
  if (url.protocol !== "https:") return "not_https";
  if (url.username || url.password) return "credentials_in_url";
  const host = url.hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || host === "localhost") {
    return "ip_literal";
  }
  const zone = chassisZone.toLowerCase();
  if (host === zone || host.endsWith(`.${zone}`)) return "chassis_host";
  if (host.endsWith(".internal") || host.endsWith(".local") || !host.includes(".")) {
    return "ip_literal";
  }
  return null;
}

/** "0.05" with 6 decimals -> 50000n. Rejects malformed or over-precise input. */
export function toBaseUnits(display: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(display);
  if (!match) return null;
  const frac = match[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(match[1] + frac.padEnd(decimals, "0"));
}

export interface CapCheck {
  /** Challenge amount in base units. */
  amount: bigint;
  /** The agent's stated ceiling for THIS payment, base units. */
  maxAmount: bigint;
  /** Colony per-transaction cap, base units. */
  maxTx: bigint;
  /** Colony daily cap, base units. */
  dailyCap: bigint;
  /** Base units already reserved or spent today (including unknowns). */
  spentToday: bigint;
}

export type CapProblem = "over_max_amount" | "over_tx_cap" | "over_daily_cap";

/**
 * The cap decision. The agent's own maxAmount binds first (a challenge
 * larger than the agent agreed to pay is refused even inside colony caps);
 * unknown outcomes count as spent until reconciled (spec §2.2).
 */
export function checkCaps(check: CapCheck): CapProblem | null {
  if (check.amount > check.maxAmount) return "over_max_amount";
  if (check.amount > check.maxTx) return "over_tx_cap";
  if (check.spentToday + check.amount > check.dailyCap) return "over_daily_cap";
  return null;
}

/** "promoter" -> "SPEND_TOKEN_PROMOTER" (money bearers are per-agent). */
export function spendTokenVar(agentId: string): string {
  return `SPEND_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
}

export interface ChallengeSummary {
  origin: string;
  method: string;
  recipient: string;
  /** The asset being charged (token address / method currency id). */
  currency: string;
  /** Base units, as a decimal string of the integer. */
  amount: string;
  decimals: number;
  /** Human-readable display amount. */
  display: string;
  description?: string;
}

/**
 * Parse "0xaddr=6,0xother=18" into a lowercased currency-to-decimals map:
 * the colony's spend-side allowlist of KNOWN assets. The wire challenge
 * does not carry decimals, so an asset outside this map has unknowable
 * base units and is therefore unpayable, which is also the right
 * security posture: the colony only ever pays in tokens it recognizes.
 */
export function parseCurrencyMap(raw: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of (raw ?? "").split(",")) {
    const [address, decimals] = entry.split("=").map(part => part.trim());
    // Explicit digits required: Number("") is 0, which would silently give
    // a malformed entry zero decimals and wrong cap arithmetic.
    if (!address || !decimals || !/^\d{1,2}$/.test(decimals)) continue;
    const parsed = Number(decimals);
    if (parsed <= 36) map.set(address.toLowerCase(), parsed);
  }
  return map;
}

/**
 * Extract the policy-relevant facts from a parsed MPP challenge. Returns
 * null when a required fact is missing OR the asset is not in the known
 * currency map: an unreadable challenge is never payable.
 */
export function summarizeChallenge(
  url: string,
  challenge: {
    method?: string;
    description?: string;
    request?: Record<string, unknown>;
  },
  currencies: Map<string, number>
): ChallengeSummary | null {
  const request = challenge.request ?? {};
  const amount = typeof request.amount === "string" ? request.amount : null;
  const recipient = typeof request.recipient === "string" ? request.recipient : null;
  const currency = typeof request.currency === "string" ? request.currency : null;
  const method = typeof challenge.method === "string" ? challenge.method : null;
  if (!amount || !recipient || !currency || !method || !/^\d+$/.test(amount)) {
    return null;
  }
  const decimals = currencies.get(currency.toLowerCase());
  if (decimals === undefined) return null;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const base = BigInt(amount);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = base / divisor;
  const frac = (base % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return {
    origin,
    method,
    recipient,
    currency,
    amount,
    decimals,
    display: frac ? `${whole}.${frac}` : whole.toString(),
    description: challenge.description
  };
}
