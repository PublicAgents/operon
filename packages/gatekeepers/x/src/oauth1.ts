/**
 * Minimal OAuth 1.0a request signing (HMAC-SHA1) for the X API, via
 * WebCrypto so it runs in a Worker. Only what a JSON-body POST to
 * /2/tweets needs: for non-form-encoded bodies the signature covers the
 * oauth parameters and query string only (RFC 5849 3.4.1.3.1); the
 * `extraParams` input exists so the spec can verify against X's own
 * documented form-encoded example vector.
 */

/** RFC 3986 percent-encoding (stricter than encodeURIComponent). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
}

export interface SignatureInput {
  method: string;
  /** URL without query string. */
  url: string;
  /** Query and (for form bodies) body parameters to include in the base string. */
  extraParams?: Record<string, string>;
  nonce: string;
  /** Unix seconds, as a string. */
  timestamp: string;
}

export function signatureBaseString(
  input: SignatureInput,
  credentials: OAuth1Credentials
): string {
  const params: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: input.nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: input.timestamp,
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
    ...(input.extraParams ?? {})
  };
  const encoded = Object.entries(params)
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `${input.method.toUpperCase()}&${percentEncode(input.url)}&${percentEncode(encoded)}`;
}

async function hmacSha1(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function sign(
  input: SignatureInput,
  credentials: OAuth1Credentials
): Promise<string> {
  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.accessSecret)}`;
  return hmacSha1(signingKey, signatureBaseString(input, credentials));
}

/** The Authorization header for a request signed with the given inputs. */
export async function authorizationHeader(
  input: SignatureInput,
  credentials: OAuth1Credentials
): Promise<string> {
  const signature = await sign(input, credentials);
  const fields: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: input.nonce,
    oauth_signature: signature,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: input.timestamp,
    oauth_token: credentials.accessToken,
    oauth_version: "1.0"
  };
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(", ");
  return `OAuth ${rendered}`;
}
