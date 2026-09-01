import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GoogleAuthError,
  GoogleTokenSource,
  parseServiceAccount,
  type ServiceAccount
} from "./google-auth.js";

/** A throwaway key pair, generated per run: no key material in the repo. */
function testAccount(): ServiceAccount {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  return { client_email: "reader@demo.iam.gserviceaccount.com", private_key: privateKey };
}

function decodeSegment(segment: string): Record<string, unknown> {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

describe("parseServiceAccount", () => {
  it("names what is missing rather than failing later at Google", () => {
    expect(() => parseServiceAccount(undefined)).toThrow(/not configured/);
    expect(() => parseServiceAccount("{oops")).toThrow(/not valid JSON/);
    expect(() => parseServiceAccount(JSON.stringify({ client_email: "a@b" }))).toThrow(
      /client_email and private_key/
    );
  });
});

describe("GoogleTokenSource", () => {
  it("signs a scoped JWT for the service account and exchanges it", async () => {
    const account = testAccount();
    let sentAssertion = "";
    const source = new GoogleTokenSource(account, {
      now: () => 1_800_000_000_000,
      fetch: (async (_url: string, init?: RequestInit) => {
        sentAssertion = new URLSearchParams(String(init?.body)).get("assertion") ?? "";
        return new Response(JSON.stringify({ access_token: "ya29.first", expires_in: 3600 }));
      }) as typeof fetch
    });

    expect(await source.token()).toBe("ya29.first");
    const [header, claims] = sentAssertion.split(".");
    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = decodeSegment(claims);
    expect(payload.iss).toBe("reader@demo.iam.gserviceaccount.com");
    expect(payload.scope).toBe("https://www.googleapis.com/auth/analytics.readonly");
    expect(payload.aud).toBe("https://oauth2.googleapis.com/token");
    // Backdated an epsilon to absorb clock skew, and never longer than
    // Google's one-hour ceiling for this grant.
    expect(payload.iat).toBe(1_800_000_000 - 60);
    expect(payload.exp).toBe(1_800_000_000 + 3600);
  });

  it("reuses the cached token until it nears expiry, then mints again", async () => {
    const account = testAccount();
    let mints = 0;
    let now = 1_800_000_000_000;
    const source = new GoogleTokenSource(account, {
      now: () => now,
      fetch: (async () => {
        mints += 1;
        return new Response(JSON.stringify({ access_token: `ya29.${mints}`, expires_in: 3600 }));
      }) as typeof fetch
    });

    expect(await source.token()).toBe("ya29.1");
    expect(await source.token()).toBe("ya29.1");
    expect(mints).toBe(1);

    // Inside the last minute: a token that expires mid-request is a
    // failure the caller cannot tell from a real auth error.
    now += 3_541_000;
    expect(await source.token()).toBe("ya29.2");
    expect(mints).toBe(2);
  });

  it("collapses a burst of concurrent callers into one mint", async () => {
    const account = testAccount();
    let mints = 0;
    const source = new GoogleTokenSource(account, {
      fetch: (async () => {
        mints += 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        return new Response(JSON.stringify({ access_token: "ya29.shared", expires_in: 3600 }));
      }) as typeof fetch
    });

    const tokens = await Promise.all([source.token(), source.token(), source.token()]);
    expect(tokens).toEqual(["ya29.shared", "ya29.shared", "ya29.shared"]);
    expect(mints).toBe(1);
  });

  it("refuses when Google will not exchange the assertion", async () => {
    const source = new GoogleTokenSource(testAccount(), {
      fetch: (async () => new Response("nope", { status: 400 })) as typeof fetch
    });
    await expect(source.token()).rejects.toThrow(GoogleAuthError);
  });

  it("refuses a private key that is not a PKCS8 PEM", async () => {
    const source = new GoogleTokenSource(
      { client_email: "a@b", private_key: "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----" },
      { fetch: (async () => new Response("{}")) as typeof fetch }
    );
    await expect(source.token()).rejects.toThrow(/PKCS8/);
  });
});
