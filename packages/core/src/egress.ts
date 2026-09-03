/**
 * The outbound proxy table (spec 0004 §8) as the MANIFEST carries it:
 * host pattern -> proxy address or "direct", where a proxy address
 * names its credential by PLACEHOLDER, never by value:
 *
 *   { "*": "http://${PROXY_GENERAL}@general.proxy.example:7777",
 *     "docs.example": "http://${PROXY_DOCS}@other.proxy.example:8888",
 *     "*.registry.example": "direct" }
 *
 * A placeholder names a scheduler secret, EGRESS_CREDENTIAL_<NAME>,
 * holding `user:pass`. The fleet validates the table and derives the
 * secrets it needs from it; the scheduler substitutes the values at
 * launch, and only the substituted table reaches the container. A
 * literal credential in the table is refused by name: the table is
 * committed configuration, and credentials do not live in repositories.
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

/** "PROXY_GENERAL" -> "EGRESS_CREDENTIAL_PROXY_GENERAL", the scheduler secret a placeholder names. */
export function egressCredentialSecret(name: string): string {
  return `${EGRESS_CREDENTIAL_PREFIX}${name}`;
}

export interface EgressProxyTarget {
  /** scheme://host[:port], with no credential in it. */
  address: string;
  /** The placeholder name, when the address carries one. */
  credential?: string;
}

export interface EgressTableEntry {
  pattern: string;
  target: "direct" | EgressProxyTarget;
}

const PLACEHOLDER_ADDRESS = /^(https?:\/\/)\$\{([A-Z][A-Z0-9_]*)\}@(.+)$/;
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/**
 * A bare proxy address: http(s), a hostname or bracketed IPv6 literal,
 * an optional port, an optional trailing slash, nothing else. Regex
 * rather than a URL parser: this module is platform-neutral (Workers
 * and node) and typed without either's globals.
 */
const BARE_ADDRESS = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?\/?$/;

function invalid(detail: string): never {
  throw new EgressTableError("egress_table_invalid", detail);
}

/** Does the authority part (between scheme and the first slash) carry userinfo? */
function hasUserinfo(address: string): boolean {
  const authority = address.replace(/^[a-z]+:\/\//i, "").split("/")[0];
  return authority.includes("@");
}

/** Validate a bare address, returning its parts. */
function checkAddress(address: string, pattern: string): { scheme: string; hostport: string } {
  const match = BARE_ADDRESS.exec(address);
  if (!match) {
    if (!/^https?:\/\//.test(address)) invalid(`"${pattern}": scheme must be http or https`);
    if (/[?#]/.test(address) || /^https?:\/\/[^/]+\/./.test(address)) {
      invalid(`"${pattern}": a proxy address carries no path or query`);
    }
    return invalid(`"${pattern}": not a proxy address (http(s)://host[:port])`);
  }
  const port = match[3] === undefined ? undefined : Number(match[3]);
  if (port !== undefined && (port < 1 || port > 65535)) invalid(`"${pattern}": port out of range`);
  return { scheme: match[1], hostport: match[2] + (match[3] === undefined ? "" : `:${match[3]}`) };
}

/**
 * Parse and validate the table. Every entry is checked, so a typo fails
 * at manifest validation (the fleet) or wake launch (the scheduler), by
 * name, never at the first request.
 */
export function parseEgressTable(raw: string): EgressTableEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid("must be a JSON object of host pattern to proxy address or \"direct\"");
  }
  const entries: EgressTableEntry[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const pattern = key.trim().toLowerCase();
    if (pattern !== "*" && !HOST_PATTERN.test(pattern)) invalid(`bad host pattern "${key}"`);
    if (typeof value !== "string") invalid(`"${key}" must be a proxy address or "direct"`);
    const text = value.trim();
    if (text === "direct") {
      entries.push({ pattern, target: "direct" });
      continue;
    }
    const placeholder = PLACEHOLDER_ADDRESS.exec(text);
    if (placeholder) {
      const address = placeholder[1] + placeholder[3];
      if (hasUserinfo(address)) {
        throw new EgressTableError(
          "egress_table_literal_credential",
          `"${pattern}" carries a credential beside its placeholder; only the placeholder belongs here`
        );
      }
      checkAddress(address, pattern);
      entries.push({ pattern, target: { address, credential: placeholder[2] } });
      continue;
    }
    if (/^https?:\/\//.test(text) && hasUserinfo(text)) {
      throw new EgressTableError(
        "egress_table_literal_credential",
        `"${pattern}" carries a literal credential; name it as \${NAME} and set the secret ${egressCredentialSecret("NAME")} instead`
      );
    }
    checkAddress(text, pattern);
    entries.push({ pattern, target: { address: text } });
  }
  if (entries.length === 0) invalid("no routes");
  return entries;
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

/** The placeholder names a table uses, in table order, each once. */
export function egressTableCredentials(raw: string): string[] {
  const names: string[] = [];
  for (const entry of parseEgressTable(raw)) {
    if (entry.target !== "direct" && entry.target.credential && !names.includes(entry.target.credential)) {
      names.push(entry.target.credential);
    }
  }
  return names;
}

/**
 * The table with every placeholder replaced by its secret's value, as
 * the JSON the container is handed (OPERON_EGRESS_PROXY). A secret holds
 * `user:pass` (the first colon splits; a value without one is a
 * username alone); each half is percent-encoded into the URL, so a
 * password may hold any character. A placeholder whose secret is not
 * configured fails the launch by name.
 */
export function resolveEgressTable(raw: string, getSecret: (name: string) => string | undefined): string {
  const resolved: Record<string, string> = {};
  for (const entry of parseEgressTable(raw)) {
    if (entry.target === "direct") {
      resolved[entry.pattern] = "direct";
      continue;
    }
    if (!entry.target.credential) {
      resolved[entry.pattern] = entry.target.address;
      continue;
    }
    const secretName = egressCredentialSecret(entry.target.credential);
    const value = getSecret(secretName);
    if (!value) {
      throw new EgressTableError(
        "egress_credential_missing",
        `secret ${secretName} is not configured (named by the proxy table's "${entry.pattern}" entry)`
      );
    }
    const colon = value.indexOf(":");
    // Percent-encoded, so any character survives the round trip through
    // the container's parser (which decodes each half).
    const userinfo =
      colon < 0
        ? encodeURIComponent(value)
        : `${encodeURIComponent(value.slice(0, colon))}:${encodeURIComponent(value.slice(colon + 1))}`;
    const { scheme, hostport } = checkAddress(entry.target.address, entry.pattern);
    resolved[entry.pattern] = `${scheme}://${userinfo}@${hostport}`;
  }
  return JSON.stringify(resolved);
}
