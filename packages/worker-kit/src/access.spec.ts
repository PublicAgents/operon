import { beforeAll, describe, expect, it } from "vitest";
import { extractAccessToken, verifyAccessJwt, type AccessConfig } from "./access.js";

/**
 * Real RS256: a keypair is generated, a JWT signed, and verifyAccessJwt
 * validates it against a JWKS served by an injected fetch. Every claim
 * pin (aud, iss, exp) and the signature are exercised against genuine
 * crypto, so a broken verifier cannot pass.
 */

const TEAM = "https://acme.cloudflareaccess.com";
const AUD = "aud-tag-123";
const NOW = 1_800_000_000_000; // fixed ms

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

let keyPair: CryptoKeyPair;
let jwk: JsonWebKey;
let config: AccessConfig;

async function sign(payload: Record<string, unknown>, kid = "k1"): Promise<string> {
  const head = b64urlJson({ alg: "RS256", kid, typ: "JWT" });
  const body = b64urlJson(payload);
  const data = new TextEncoder().encode(`${head}.${body}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, data);
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const validPayload = () => ({
  aud: [AUD],
  iss: TEAM,
  exp: Math.floor(NOW / 1000) + 600,
  email: "operator@example.com",
  sub: "user-1"
});

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ keys: [{ kid: "k1", kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" }] }), {
      status: 200
    })) as typeof fetch;
  config = { teamDomain: TEAM, aud: AUD, fetchImpl, now: () => NOW };
});

describe("verifyAccessJwt", () => {
  it("accepts a correctly signed, correctly claimed token", async () => {
    const result = await verifyAccessJwt(await sign(validPayload()), config);
    expect(result).toEqual({ ok: true, identity: { email: "operator@example.com", sub: "user-1" } });
  });

  it("rejects a wrong audience", async () => {
    const result = await verifyAccessJwt(await sign({ ...validPayload(), aud: ["other"] }), config);
    expect(result).toEqual({ ok: false, reason: "wrong_aud" });
  });

  it("rejects a wrong issuer", async () => {
    const result = await verifyAccessJwt(await sign({ ...validPayload(), iss: "https://evil" }), config);
    expect(result).toEqual({ ok: false, reason: "wrong_iss" });
  });

  it("rejects an expired token", async () => {
    const result = await verifyAccessJwt(await sign({ ...validPayload(), exp: Math.floor(NOW / 1000) - 1 }), config);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered payload (signature fails)", async () => {
    const token = await sign(validPayload());
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64urlJson({ ...validPayload(), email: "attacker@evil.com" })}.${s}`;
    const result = await verifyAccessJwt(forged, config);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an unknown key id", async () => {
    const result = await verifyAccessJwt(await sign(validPayload(), "unknown-kid"), config);
    expect(result).toEqual({ ok: false, reason: "unknown_kid" });
  });
});

describe("extractAccessToken", () => {
  it("reads the header, then the cookie", () => {
    expect(extractAccessToken(new Request("https://x/", { headers: { "cf-access-jwt-assertion": "H" } }))).toBe("H");
    expect(extractAccessToken(new Request("https://x/", { headers: { cookie: "a=1; CF_Authorization=C; b=2" } }))).toBe("C");
    expect(extractAccessToken(new Request("https://x/"))).toBeNull();
  });
});
