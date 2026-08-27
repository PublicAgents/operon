/**
 * Cloudflare Access JWT verification (spec 0003 §3), done IN-WORKER so a
 * routing mistake fails closed rather than trusting that Access ran. On
 * every request Access injects a signed JWT (the `Cf-Access-Jwt-Assertion`
 * header, or the `CF_Authorization` cookie); this validates its RS256
 * signature against the team's JWKS, and pins the audience to the Access
 * application's AUD tag, the issuer to the team domain, and the expiry.
 *
 * No dependency: RS256 verification is WebCrypto, and the JWKS is fetched
 * and cached per isolate.
 */

export interface AccessConfig {
  /** e.g. "https://<team>.cloudflareaccess.com" (no trailing slash). */
  teamDomain: string;
  /** The Access application's Audience (AUD) tag. */
  aud: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

export interface AccessIdentity {
  /** The authenticated user's email (Access `email` claim). */
  email: string;
  /** Access `sub` (stable user id). */
  sub: string;
}

export type AccessResult =
  | { ok: true; identity: AccessIdentity }
  | { ok: false; reason: string };

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000;

async function loadKeys(config: AccessConfig): Promise<Jwk[] | null> {
  const now = (config.now ?? Date.now)();
  const cached = jwksCache.get(config.teamDomain);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  try {
    const response = await (config.fetchImpl ?? fetch)(
      `${config.teamDomain}/cdn-cgi/access/certs`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return cached?.keys ?? null;
    const body = (await response.json()) as { keys?: Jwk[] };
    if (!body.keys) return cached?.keys ?? null;
    jwksCache.set(config.teamDomain, { keys: body.keys, fetchedAt: now });
    return body.keys;
  } catch {
    return cached?.keys ?? null;
  }
}

/** The Access token from the header or the CF_Authorization cookie. */
export function extractAccessToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const cookie = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match ? match[1] : null;
}

export async function verifyAccessJwt(token: string, config: AccessConfig): Promise<AccessResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (!header || !payload) return { ok: false, reason: "undecodable" };
  if (header.alg !== "RS256") return { ok: false, reason: "wrong_alg" };

  // Audience pin: the app's AUD tag must be present.
  const aud = payload.aud;
  const auds = Array.isArray(aud) ? aud : typeof aud === "string" ? [aud] : [];
  if (!auds.includes(config.aud)) return { ok: false, reason: "wrong_aud" };
  // Issuer pin.
  if (payload.iss !== config.teamDomain) return { ok: false, reason: "wrong_iss" };
  // Expiry / not-before.
  const now = Math.floor((config.now ?? Date.now)() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return { ok: false, reason: "expired" };
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return { ok: false, reason: "not_yet_valid" };

  const keys = await loadKeys(config);
  if (!keys) return { ok: false, reason: "jwks_unavailable" };
  const key = keys.find(candidate => candidate.kid === header.kid);
  if (!key) return { ok: false, reason: "unknown_kid" };

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
  } catch {
    return { ok: false, reason: "bad_key" };
  }
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    base64UrlToBytes(parts[2]),
    signed
  );
  if (!valid) return { ok: false, reason: "bad_signature" };

  const email = typeof payload.email === "string" ? payload.email : "";
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  return { ok: true, identity: { email, sub } };
}

/** Convenience: verify straight from the request. */
export async function verifyAccessRequest(
  request: Request,
  config: AccessConfig
): Promise<AccessResult> {
  const token = extractAccessToken(request);
  if (!token) return { ok: false, reason: "no_token" };
  return verifyAccessJwt(token, config);
}
