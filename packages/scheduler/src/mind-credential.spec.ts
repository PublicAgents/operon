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
  REFRESH_AFTER_MS
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
