import { describe, expect, it } from "vitest";
import { chooseCredential, credentialAccount, credentialFingerprint, judgeRelay } from "./mind-credential.js";

const login = (account: string, refresh = "r1") =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { id_token: "i", access_token: "a", refresh_token: refresh, account_id: account },
    last_refresh: "2026-09-01T00:00:00Z"
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

describe("credentialAccount", () => {
  it("reads the account of a login file and nothing from anything else", () => {
    expect(credentialAccount(login("acct-1"))).toBe("acct-1");
    expect(credentialAccount("sk-api-key")).toBeUndefined();
    expect(credentialAccount(JSON.stringify({ tokens: {} }))).toBeUndefined();
  });
});

describe("judgeRelay (spec 0010 §5)", () => {
  it("accepts a refreshed login of the seeded account", () => {
    expect(judgeRelay("acct-1", login("acct-1", "r2"))).toEqual({ ok: true, value: login("acct-1", "r2") });
  });

  it("refuses by name: another account, no account, not a credential, too large, or a seed without account", () => {
    expect(judgeRelay("acct-1", login("acct-2"))).toEqual({ ok: false, error: "relay_account_mismatch" });
    expect(judgeRelay("acct-1", "sk-something")).toEqual({ ok: false, error: "relay_has_no_account" });
    expect(judgeRelay("acct-1", 42)).toEqual({ ok: false, error: "relay_not_a_credential" });
    expect(judgeRelay("acct-1", "")).toEqual({ ok: false, error: "relay_not_a_credential" });
    expect(judgeRelay("acct-1", "x".repeat(6 * 1024))).toEqual({ ok: false, error: "relay_too_large" });
    expect(judgeRelay(undefined, login("acct-1"))).toEqual({ ok: false, error: "relay_seed_has_no_account" });
  });
});

describe("chooseCredential", () => {
  it("prefers the relayed value only while it descends from the current secret", () => {
    expect(chooseCredential("seed", "fp1", { seed: "fp1", value: "refreshed" })).toEqual({
      value: "refreshed",
      relayed: true
    });
    expect(chooseCredential("seed", "fp2", { seed: "fp1", value: "refreshed" })).toEqual({
      value: "seed",
      relayed: false
    });
    expect(chooseCredential("seed", "fp1", undefined)).toEqual({ value: "seed", relayed: false });
  });
});
