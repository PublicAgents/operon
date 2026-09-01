/**
 * Google service-account auth, done in the Worker so the key never
 * leaves it (spec 0008 §5).
 *
 * A service-account JSON key signs a short JWT, which Google exchanges
 * for an access token. Both steps are small enough to do directly, and
 * doing them here means the only copy of the private key is a Worker
 * secret, unreachable from the container and from the agent.
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export class GoogleAuthError extends Error {
  override name = "GoogleAuthError";
}

/** Read-only analytics: the narrowest scope that can answer a report. */
export const ANALYTICS_READONLY = "https://www.googleapis.com/auth/analytics.readonly";

const TOKEN_URI = "https://oauth2.googleapis.com/token";

export function parseServiceAccount(raw: string | undefined): ServiceAccount {
  if (!raw) throw new GoogleAuthError("GA_SERVICE_ACCOUNT is not configured");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GoogleAuthError("GA_SERVICE_ACCOUNT is not valid JSON");
  }
  const account = parsed as Partial<ServiceAccount>;
  if (typeof account.client_email !== "string" || typeof account.private_key !== "string") {
    throw new GoogleAuthError("GA_SERVICE_ACCOUNT needs client_email and private_key");
  }
  return account as ServiceAccount;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCS8 PEM to raw DER, the only form WebCrypto imports. */
function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  if (body.length === 0) throw new GoogleAuthError("private_key is not a PKCS8 PEM");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function signJwt(account: ServiceAccount, scope: string, nowSeconds: number): Promise<string> {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: account.client_email,
        scope,
        aud: account.token_uri ?? TOKEN_URI,
        // A minute of backdating absorbs clock skew; an hour is
        // Google's ceiling for this grant and we do not need longer.
        iat: nowSeconds - 60,
        exp: nowSeconds + 3600
      })
    )
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(account.private_key) as unknown as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`)
  );
  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
}

interface CachedToken {
  token: string;
  /** Epoch seconds; refreshed before this, never after. */
  expiresAt: number;
}

/**
 * Mints access tokens and hands out the cached one until it nears
 * expiry. Concurrent callers share ONE mint: a burst of tool calls
 * would otherwise each ask Google for a token, and the burst is the
 * normal case when an agent runs several reports in a turn.
 */
export class GoogleTokenSource {
  #cached: CachedToken | null = null;
  #inFlight: Promise<string> | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly deps: { fetch?: typeof fetch; now?: () => number } = {}
  ) {}

  private get now(): number {
    return Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
  }

  async token(scope = ANALYTICS_READONLY): Promise<string> {
    // 60s of headroom: a token that expires mid-request is a failure
    // the caller cannot distinguish from a real auth error.
    if (this.#cached && this.#cached.expiresAt - 60 > this.now) return this.#cached.token;
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.mint(scope).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  private async mint(scope: string): Promise<string> {
    const doFetch = this.deps.fetch ?? fetch;
    const assertion = await signJwt(this.account, scope, this.now);
    const response = await doFetch(this.account.token_uri ?? TOKEN_URI, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      }).toString()
    });
    if (!response.ok) {
      throw new GoogleAuthError(`token exchange failed (${response.status})`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new GoogleAuthError("token exchange returned no access_token");
    this.#cached = {
      token: body.access_token,
      expiresAt: this.now + (body.expires_in ?? 3600)
    };
    return this.#cached.token;
  }
}
