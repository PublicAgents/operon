/**
 * GitHub App JWT (RS256) via WebCrypto, no dependencies. The App private
 * key enters as PKCS8 PEM ("-----BEGIN PRIVATE KEY-----"); GitHub's
 * downloads are PKCS1 ("BEGIN RSA PRIVATE KEY") and must be converted once
 * at setup: openssl pkcs8 -topk8 -nocrypt -in app.pem
 */

function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromJson(value: unknown): string {
  return base64urlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export function pemToPkcs8Bytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  if (body.length === 0 || /BEGIN/.test(pem.replace(/-----BEGIN PRIVATE KEY-----/, ""))) {
    throw new Error(
      "private_key_not_pkcs8: expected a PKCS8 PEM (BEGIN PRIVATE KEY); convert with openssl pkcs8 -topk8 -nocrypt"
    );
  }
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function signAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Bytes(privateKeyPem).buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  // 60s of clock-drift allowance backward, 9min lifetime: GitHub caps at 10.
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId };
  const signingInput = `${base64urlFromJson({ alg: "RS256", typ: "JWT" })}.${base64urlFromJson(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64urlFromBytes(new Uint8Array(signature))}`;
}
