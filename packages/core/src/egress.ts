/**
 * The session's egress policy (spec 0004 §5, §8) as the MANIFEST carries
 * it. Proxies are DEFINED once, by name, and the host map REFERENCES
 * them, so a proxy's address and credential live in one place and the
 * name travels to the container, where every audit line records it:
 *
 *   egress:
 *     proxies:
 *       general: { address: http://general.proxy.example:7777, credential: PROXY_GENERAL }
 *       docs:    { address: http://other.proxy.example:8888,   credential: PROXY_DOCS }
 *     proxy:
 *       "*": general
 *       docs.example: docs
 *       "*.registry.example": direct
 *
 * A proxy's `credential` NAMES a scheduler secret, EGRESS_CREDENTIAL_<NAME>,
 * holding `user:pass`; the address itself never carries one, and a
 * literal credential is refused by name because the manifest is
 * committed configuration. The fleet validates the policy and derives
 * the secrets it needs; the scheduler substitutes the values at launch;
 * only the substituted policy reaches the container.
 *
 * Owned here so the fleet (which validates) and the scheduler (which
 * substitutes) read one grammar; the container's own parser stays
 * separate (its build context is the container alone) and sees only
 * substituted values.
 */

export class EgressTableError extends Error {
  override name = "EgressTableError";
  constructor(
    readonly code: string,
    detail: string
  ) {
    super(`${code}: ${detail}`);
  }
}

export const EGRESS_CREDENTIAL_PREFIX = "EGRESS_CREDENTIAL_";

/** "PROXY_GENERAL" -> "EGRESS_CREDENTIAL_PROXY_GENERAL", the scheduler secret a proxy names. */
export function egressCredentialSecret(name: string): string {
  return `${EGRESS_CREDENTIAL_PREFIX}${name}`;
}

export interface EgressProxyDef {
  /** scheme://host[:port], with no credential in it. */
  address: string;
  /** The credential's name; the secret is EGRESS_CREDENTIAL_<NAME>. */
  credential?: string;
}

export interface EgressPolicy {
  proxies: Record<string, EgressProxyDef>;
  /** Host pattern -> proxy name, or "direct". */
  routes: Record<string, string>;
}

const PROXY_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]*$/;
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/**
 * A bare proxy address: http(s), a hostname or bracketed IPv6 literal,
 * an optional port, an optional trailing slash, nothing else. Regex
 * rather than a URL parser: this module is platform-neutral (Workers
 * and node) and typed without either's globals.
 */
const BARE_ADDRESS = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?\/?$/;

function invalid(detail: string): never {
  throw new EgressTableError("egress_policy_invalid", detail);
}

/** Does the authority part (between scheme and the first slash) carry userinfo? */
function hasUserinfo(address: string): boolean {
  const authority = address.replace(/^[a-z]+:\/\//i, "").split("/")[0];
  return authority.includes("@");
}

/** Validate a bare address, returning its parts. */
function checkAddress(address: string, name: string): { scheme: string; hostport: string } {
  if (/^https?:\/\//.test(address) && hasUserinfo(address)) {
    throw new EgressTableError(
      "egress_policy_literal_credential",
      `proxy "${name}" carries a credential in its address; name it with \`credential: NAME\` and set the secret ${egressCredentialSecret("NAME")} instead`
    );
  }
  const match = BARE_ADDRESS.exec(address);
  if (!match) {
    if (!/^https?:\/\//.test(address)) invalid(`proxy "${name}": scheme must be http or https`);
    if (/[?#]/.test(address) || /^https?:\/\/[^/]+\/./.test(address)) {
      invalid(`proxy "${name}": a proxy address carries no path or query`);
    }
    return invalid(`proxy "${name}": not a proxy address (http(s)://host[:port])`);
  }
  const port = match[3] === undefined ? undefined : Number(match[3]);
  if (port !== undefined && (port < 1 || port > 65535)) invalid(`proxy "${name}": port out of range`);
  return { scheme: match[1], hostport: match[2] + (match[3] === undefined ? "" : `:${match[3]}`) };
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${what} must be a mapping`);
  return value as Record<string, unknown>;
}

/**
 * Parse and validate the policy, from the manifest's object or the
 * scheduler's JSON var. Every proxy and every route is checked, so a
 * typo fails at manifest validation (the fleet) or wake launch (the
 * scheduler), by name, never at the first request.
 */
export function parseEgressPolicy(raw: unknown): EgressPolicy {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      invalid("not valid JSON");
    }
  }
  const record = requireRecord(value, "the egress policy");
  for (const key of Object.keys(record)) {
    if (key !== "proxies" && key !== "routes") invalid(`unknown key "${key}" (known: proxies, routes)`);
  }
  const proxies: Record<string, EgressProxyDef> = {};
  if (record.proxies !== undefined) {
    for (const [name, def] of Object.entries(requireRecord(record.proxies, "proxies"))) {
      if (!PROXY_NAME.test(name)) invalid(`bad proxy name "${name}" (lowercase, digits, hyphens)`);
      const entry = requireRecord(def, `proxy "${name}"`);
      for (const key of Object.keys(entry)) {
        if (key !== "address" && key !== "credential") invalid(`proxy "${name}": unknown key "${key}"`);
      }
      if (typeof entry.address !== "string") invalid(`proxy "${name}": address must be a string`);
      checkAddress(entry.address.trim(), name);
      const proxy: EgressProxyDef = { address: entry.address.trim() };
      if (entry.credential !== undefined) {
        if (typeof entry.credential !== "string" || !CREDENTIAL_NAME.test(entry.credential)) {
          invalid(`proxy "${name}": credential must be a NAME (uppercase, digits, underscores)`);
        }
        proxy.credential = entry.credential;
      }
      proxies[name] = proxy;
    }
  }
  const routes: Record<string, string> = {};
  if (record.routes !== undefined) {
    for (const [key, target] of Object.entries(requireRecord(record.routes, "routes"))) {
      const pattern = key.trim().toLowerCase();
      if (pattern !== "*" && !HOST_PATTERN.test(pattern)) invalid(`bad host pattern "${key}"`);
      if (typeof target !== "string") invalid(`route "${key}" must name a proxy or "direct"`);
      const name = target.trim();
      if (name !== "direct" && !(name in proxies)) invalid(`route "${key}" names an unknown proxy "${name}"`);
      routes[pattern] = name;
    }
  }
  return { proxies, routes };
}

/** The credential names the policy uses, in definition order, each once. */
export function egressPolicyCredentials(policy: EgressPolicy): string[] {
  const names: string[] = [];
  for (const proxy of Object.values(policy.proxies)) {
    if (proxy.credential && !names.includes(proxy.credential)) names.push(proxy.credential);
  }
  return names;
}

/**
 * The policy with every credential substituted, as the JSON the
 * container is handed (OPERON_EGRESS_PROXY): each proxy's address with
 * its `user:pass` percent-encoded into the URL, and the routes as
 * written. A secret holds `user:pass` (the first colon splits; a value
 * without one is a username alone). A named credential whose secret is
 * not configured fails the launch by name.
 */
export function resolveEgressPolicy(policy: EgressPolicy, getSecret: (name: string) => string | undefined): string {
  const proxies: Record<string, string> = {};
  for (const [name, proxy] of Object.entries(policy.proxies)) {
    if (!proxy.credential) {
      proxies[name] = proxy.address;
      continue;
    }
    const secretName = egressCredentialSecret(proxy.credential);
    const value = getSecret(secretName);
    if (!value) {
      throw new EgressTableError(
        "egress_credential_missing",
        `secret ${secretName} is not configured (named by proxy "${name}")`
      );
    }
    const colon = value.indexOf(":");
    // Percent-encoded, so any character survives the round trip through
    // the container's parser (which decodes each half).
    const userinfo =
      colon < 0
        ? encodeURIComponent(value)
        : `${encodeURIComponent(value.slice(0, colon))}:${encodeURIComponent(value.slice(colon + 1))}`;
    const { scheme, hostport } = checkAddress(proxy.address, name);
    proxies[name] = `${scheme}://${userinfo}@${hostport}`;
  }
  return JSON.stringify({ proxies, routes: policy.routes });
}

/**
 * The egress blocklist (spec 0004 §5, §8): host patterns the session
 * may not reach, "*", an exact host, or "*.domain". One list serves
 * the browser door (the relay and the platform guardrails) and the
 * container forwarder, rendered from the manifest to both.
 */
export function parseEgressBlocklist(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new EgressTableError("egress_blocklist_invalid", "must be a list of host patterns");
  const patterns: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") throw new EgressTableError("egress_blocklist_invalid", "entries must be strings");
    const pattern = entry.trim().toLowerCase();
    if (pattern !== "*" && !HOST_PATTERN.test(pattern)) {
      throw new EgressTableError("egress_blocklist_invalid", `bad host pattern "${entry}"`);
    }
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns;
}
