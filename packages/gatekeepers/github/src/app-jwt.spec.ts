import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { pemToPkcs8Bytes, signAppJwt } from "./app-jwt.js";

function testKeyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function base64urlToJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString());
}

describe("signAppJwt", () => {
  it("produces a JWT GitHub can verify against the public key", async () => {
    const { privateKey, publicKey } = testKeyPair();
    const now = 1_700_000_000;
    const jwt = await signAppJwt("12345", privateKey, now);

    const [header, payload, signature] = jwt.split(".");
    expect(base64urlToJson(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(base64urlToJson(payload)).toEqual({
      iat: now - 60,
      exp: now + 540,
      iss: "12345"
    });

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("rejects a PKCS1 key with a named, actionable error", () => {
    expect(() =>
      pemToPkcs8Bytes("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")
    ).toThrowError(/private_key_not_pkcs8.*openssl pkcs8/);
  });
});
