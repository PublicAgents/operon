import { describe, expect, it } from "vitest";
import {
  accessTokenExpiry,
  chooseCredential,
  credentialFingerprint,
  loginNeedsRefresh,
  parseCodexLogin,
  refreshCodexLogin,
  RefreshError,
  CODEX_TOKEN_ENDPOINT,
  REFRESH_AFTER_MS,
  GROK_REFRESH_MARGIN_MS,
  authorizeHint,
  grokAccessTokenExpiry,
  grokLoginNeedsRefresh,
  grokTokenEndpoint,
  parseGrokLogin,
  refreshGrokLogin,
  refreshLogin,
  refreshPlan
} from "./mind-credential.js";

const jwt = (payload: object) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-09-10T00:00:00Z");
const login = (lastRefresh: string, exp = now / 1000 + 3 * 86400) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "i", access_token: jwt({ exp }), refresh_token: "r1", account_id: "acct-1" },
    last_refresh: lastRefresh
  });

describe("credentialFingerprint", () => {
  it("is a stable hex digest that does not contain the secret", async () => {
    const a = await credentialFingerprint("setup-token-1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(await credentialFingerprint("setup-token-1"));
    expect(a).not.toBe(await credentialFingerprint("setup-token-2"));
    expect(a).not.toContain("setup-token");
  });
});

describe("parseCodexLogin", () => {
  it("reads a login file and nothing from a token or an API key", () => {
    expect(parseCodexLogin(login("2026-09-01T00:00:00Z"))?.tokens.account_id).toBe("acct-1");
    expect(parseCodexLogin("sk-api-key")).toBeUndefined();
    expect(parseCodexLogin(JSON.stringify({ hello: 1 }))).toBeUndefined();
  });
});

describe("loginNeedsRefresh (spec 0010 §5)", () => {
  it("is due a day before Codex's own eight-day interval, and never without a refresh token", () => {
    expect(loginNeedsRefresh(parseCodexLogin(login(new Date(now - 6 * DAY).toISOString()))!, now)).toBe(false);
    expect(loginNeedsRefresh(parseCodexLogin(login(new Date(now - 7 * DAY).toISOString()))!, now)).toBe(true);
    expect(loginNeedsRefresh(parseCodexLogin(login("not a date"))!, now)).toBe(true);
    const noRefresh = parseCodexLogin(login(new Date(now - 30 * DAY).toISOString()))!;
    delete noRefresh.tokens.refresh_token;
    expect(loginNeedsRefresh(noRefresh, now)).toBe(false);
    expect(REFRESH_AFTER_MS).toBe(7 * DAY);
  });
});

describe("accessTokenExpiry", () => {
  it("reads exp from the JWT payload and is undefined for anything else", () => {
    expect(accessTokenExpiry(parseCodexLogin(login("x", 1_800_000_000))!)).toBe(1_800_000_000_000);
    expect(accessTokenExpiry({ tokens: { access_token: "opaque" } })).toBeUndefined();
    expect(accessTokenExpiry({ tokens: {} })).toBeUndefined();
  });
});

describe("refreshCodexLogin", () => {
  it("posts the refresh grant with Codex's public client and writes the rotated tokens back", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ id_token: "i2", access_token: "a2", refresh_token: "r2" });
    };
    const refreshed = await refreshCodexLogin(parseCodexLogin(login("2026-09-01T00:00:00Z"))!, fetchImpl, now);
    expect(calls).toEqual([
      {
        url: CODEX_TOKEN_ENDPOINT,
        body: { client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token: "r1" }
      }
    ]);
    const file = JSON.parse(refreshed) as { tokens: Record<string, string>; last_refresh: string; auth_mode: string };
    expect(file.tokens).toEqual({ id_token: "i2", access_token: "a2", refresh_token: "r2", account_id: "acct-1" });
    expect(file.last_refresh).toBe("2026-09-10T00:00:00.000Z");
    expect(file.auth_mode).toBe("chatgpt");
  });

  it("keeps the old refresh token when the authority does not rotate it", async () => {
    const refreshed = await refreshCodexLogin(
      parseCodexLogin(login("2026-09-01T00:00:00Z"))!,
      async () => Response.json({ access_token: "a2" }),
      now
    );
    expect(JSON.parse(refreshed).tokens.refresh_token).toBe("r1");
  });

  it("names the authority's refusal, an unreachable authority, and a malformed answer", async () => {
    const parsed = parseCodexLogin(login("2026-09-01T00:00:00Z"))!;
    await expect(
      refreshCodexLogin(parsed, async () => Response.json({ error: "refresh_token_reused" }, { status: 400 }))
    ).rejects.toThrowError(/refresh_failed:refresh_token_reused/);
    await expect(
      refreshCodexLogin(parsed, async () => {
        throw new Error("dns");
      })
    ).rejects.toThrowError(/refresh_unreachable/);
    await expect(refreshCodexLogin(parsed, async () => Response.json({}))).rejects.toThrowError(RefreshError);
    await expect(refreshCodexLogin({ tokens: {} }, async () => Response.json({}))).rejects.toThrowError(
      /refresh_token_missing/
    );
  });
});

describe("chooseCredential", () => {
  it("prefers the stored refresh only while it descends from the current secret", () => {
    expect(chooseCredential("seed", "fp1", { seed: "fp1", value: "refreshed" })).toEqual({
      value: "refreshed",
      refreshed: true
    });
    expect(chooseCredential("seed", "fp2", { seed: "fp1", value: "refreshed" })).toEqual({
      value: "seed",
      refreshed: false
    });
    expect(chooseCredential("seed", "fp1", undefined)).toEqual({ value: "seed", refreshed: false });
  });
});

const HOUR = 60 * 60 * 1000;
const grokFile = (expiryMs: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    "https://auth.x.ai::client-1": {
      key: jwt({ exp: expiryMs / 1000, aud: "client-1" }),
      auth_mode: "oidc",
      email: "mind@example.org",
      user_id: "u-1",
      refresh_token: "g-r1",
      expires_at: new Date(expiryMs).toISOString(),
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "client-1",
      ...extra
    }
  });

describe("parseGrokLogin", () => {
  it("finds the issuer-keyed entry with an access token and nothing in other credentials", () => {
    const parsed = parseGrokLogin(grokFile(now + 6 * HOUR));
    expect(parsed?.entryKey).toBe("https://auth.x.ai::client-1");
    expect(parsed?.entry.oidc_client_id).toBe("client-1");
    expect(parseGrokLogin("xai-api-key")).toBeUndefined();
    expect(parseGrokLogin(login("2026-09-01T00:00:00Z"))).toBeUndefined();
    expect(parseGrokLogin(JSON.stringify({ "https://auth.x.ai::c": { email: "x" } }))).toBeUndefined();
  });
});

describe("grokLoginNeedsRefresh (spec 0010 §5)", () => {
  it("is due under three hours before the access token expires, from the JWT first, else expires_at", () => {
    expect(GROK_REFRESH_MARGIN_MS).toBe(3 * HOUR);
    expect(grokLoginNeedsRefresh(parseGrokLogin(grokFile(now + 4 * HOUR))!, now)).toBe(false);
    expect(grokLoginNeedsRefresh(parseGrokLogin(grokFile(now + 2 * HOUR))!, now)).toBe(true);
    expect(grokLoginNeedsRefresh(parseGrokLogin(grokFile(now - HOUR))!, now)).toBe(true);
    const opaque = parseGrokLogin(grokFile(now + 5 * HOUR, { key: "opaque-token" }))!;
    expect(grokAccessTokenExpiry(opaque)).toBe(now + 5 * HOUR);
    expect(grokLoginNeedsRefresh(opaque, now)).toBe(false);
    const dateless = parseGrokLogin(grokFile(now, { key: "opaque-token", expires_at: "never" }))!;
    expect(grokAccessTokenExpiry(dateless)).toBeUndefined();
    expect(grokLoginNeedsRefresh(dateless, now)).toBe(true);
  });

  it("never refreshes an entry that cannot name its authority or has no refresh token", () => {
    expect(grokLoginNeedsRefresh(parseGrokLogin(grokFile(now, { refresh_token: undefined }))!, now)).toBe(false);
    expect(grokLoginNeedsRefresh(parseGrokLogin(grokFile(now, { oidc_issuer: "http://evil" }))!, now)).toBe(false);
    expect(grokLoginNeedsRefresh(parseGrokLogin(grokFile(now, { oidc_client_id: "" }))!, now)).toBe(false);
  });
});

describe("refreshGrokLogin", () => {
  it("posts the form-encoded refresh grant to the issuer's token endpoint and rewrites only the entry", async () => {
    const calls: { url: string; contentType: string | undefined; body: string }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ url: String(url), contentType: headers["content-type"], body: String(init?.body) });
      return Response.json({ access_token: "a2", refresh_token: "g-r2", expires_in: 21600, id_token: "ignored" });
    };
    const refreshed = await refreshGrokLogin(parseGrokLogin(grokFile(now + HOUR))!, fetchImpl, now);
    expect(grokTokenEndpoint("https://auth.x.ai/")).toBe("https://auth.x.ai/oauth2/token");
    expect(calls).toEqual([
      {
        url: "https://auth.x.ai/oauth2/token",
        contentType: "application/x-www-form-urlencoded",
        body: "grant_type=refresh_token&client_id=client-1&refresh_token=g-r1"
      }
    ]);
    const file = JSON.parse(refreshed) as Record<string, Record<string, unknown>>;
    const entry = file["https://auth.x.ai::client-1"];
    expect(entry.key).toBe("a2");
    expect(entry.refresh_token).toBe("g-r2");
    expect(entry.expires_at).toBe(new Date(now + 6 * HOUR).toISOString());
    expect(entry.email).toBe("mind@example.org");
    expect(entry.user_id).toBe("u-1");
    expect(entry.id_token).toBeUndefined();
    expect(Object.keys(file)).toEqual(["https://auth.x.ai::client-1"]);
  });

  it("keeps the refresh token when none is returned and takes the lifetime from the new token when expires_in is absent", async () => {
    const exp = now / 1000 + 5 * 3600;
    const refreshed = await refreshGrokLogin(
      parseGrokLogin(grokFile(now + HOUR))!,
      async () => Response.json({ access_token: jwt({ exp }) }),
      now
    );
    const entry = JSON.parse(refreshed)["https://auth.x.ai::client-1"] as Record<string, unknown>;
    expect(entry.refresh_token).toBe("g-r1");
    expect(entry.expires_at).toBe(new Date(exp * 1000).toISOString());
  });

  it("names the authority's refusal, an unreachable authority, a malformed answer, and a missing grant", async () => {
    const parsed = parseGrokLogin(grokFile(now + HOUR))!;
    await expect(
      refreshGrokLogin(parsed, async () => Response.json({ error: "invalid_grant" }, { status: 400 }))
    ).rejects.toThrowError(/refresh_failed:invalid_grant/);
    await expect(
      refreshGrokLogin(parsed, async () => {
        throw new Error("dns");
      })
    ).rejects.toThrowError(/refresh_unreachable/);
    await expect(refreshGrokLogin(parsed, async () => Response.json({}))).rejects.toThrowError(/refresh_malformed/);
    await expect(
      refreshGrokLogin(parseGrokLogin(grokFile(now, { refresh_token: undefined }))!, async () => Response.json({}))
    ).rejects.toThrowError(/refresh_token_missing/);
  });
});

describe("refreshPlan and refreshLogin dispatch by harness", () => {
  it("plans a codex or grok login and nothing else", () => {
    expect(refreshPlan("codex", login("2026-09-01T00:00:00Z"), now)).toEqual({ due: true, expiry: now + 3 * 86400 * 1000 });
    expect(refreshPlan("grok", grokFile(now + 2 * HOUR), now)).toEqual({ due: true, expiry: now + 2 * HOUR });
    expect(refreshPlan("grok", grokFile(now + 5 * HOUR), now)).toEqual({ due: false, expiry: now + 5 * HOUR });
    expect(refreshPlan("codex", "sk-key", now)).toBeUndefined();
    expect(refreshPlan("grok", "xai-key", now)).toBeUndefined();
    expect(refreshPlan("grok", login("2026-09-01T00:00:00Z"), now)).toBeUndefined();
    expect(refreshPlan("claude-code", "setup-token", now)).toBeUndefined();
  });

  it("routes each harness to its own grant and refuses the rest by name", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async url => {
      urls.push(String(url));
      return Response.json({ access_token: "a2" });
    };
    await refreshLogin("codex", login("2026-09-01T00:00:00Z"), fetchImpl, now);
    await refreshLogin("grok", grokFile(now + HOUR), fetchImpl, now);
    expect(urls).toEqual([CODEX_TOKEN_ENDPOINT, "https://auth.x.ai/oauth2/token"]);
    await expect(refreshLogin("grok", "xai-key", fetchImpl, now)).rejects.toThrowError(/not_a_login/);
    await expect(refreshLogin("claude-code", "token", fetchImpl, now)).rejects.toThrowError(/harness_not_refreshable/);
    expect(authorizeHint("codex")).toBe("npm run authorize:codex");
    expect(authorizeHint("grok")).toBe("node operon/tools/grok-authorize.mjs");
    expect(authorizeHint("claude-code")).toContain("MIND_CREDENTIAL_CLAUDE_CODE");
  });
});
