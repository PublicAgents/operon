import { describe, expect, it } from "vitest";
import {
  allowanceMatches,
  type Allowance,
  checkCaps,
  parseCurrencyMap,
  spendTokenVar,
  summarizeChallenge,
  toBaseUnits,
  tupleKey,
  validatePayUrl
} from "./policy.js";

describe("validatePayUrl", () => {
  const ZONE = "example-colony.com";

  it("accepts a normal public https url", () => {
    expect(validatePayUrl("https://api.example.com/reports/1", ZONE)).toBeNull();
  });

  it("rejects http, credentials, and malformed urls", () => {
    expect(validatePayUrl("http://api.example.com/", ZONE)).toBe("not_https");
    expect(validatePayUrl("https://user:pw@api.example.com/", ZONE)).toBe("credentials_in_url");
    expect(validatePayUrl("nonsense", ZONE)).toBe("invalid_url");
  });

  it("rejects IP literals, bare hosts, and internal-looking names", () => {
    expect(validatePayUrl("https://10.0.0.1/x", ZONE)).toBe("ip_literal");
    expect(validatePayUrl("https://[::1]/x", ZONE)).toBe("ip_literal");
    expect(validatePayUrl("https://localhost/x", ZONE)).toBe("ip_literal");
    expect(validatePayUrl("https://intranet/x", ZONE)).toBe("ip_literal");
    expect(validatePayUrl("https://svc.internal/x", ZONE)).toBe("ip_literal");
  });

  it("denies the chassis' own hosts by name", () => {
    expect(validatePayUrl("https://example-colony.com/gatekeeper/publish", ZONE)).toBe("chassis_host");
    expect(validatePayUrl("https://email-gk.example-colony.com/x", ZONE)).toBe("chassis_host");
    expect(validatePayUrl("https://example-colony.com.evil.com/x", ZONE)).toBeNull();
  });
});

describe("toBaseUnits", () => {
  it("converts display decimals exactly", () => {
    expect(toBaseUnits("0.01", 6)).toBe(10000n);
    expect(toBaseUnits("1", 6)).toBe(1000000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
  });

  it("rejects over-precision and malformed input", () => {
    expect(toBaseUnits("0.0000001", 6)).toBeNull();
    expect(toBaseUnits("1e3", 6)).toBeNull();
    expect(toBaseUnits("-1", 6)).toBeNull();
  });
});

describe("checkCaps", () => {
  const base = {
    amount: 10000n,
    maxAmount: 20000n,
    maxTx: 100000n,
    dailyCap: 1000000n,
    spentToday: 0n
  };

  it("passes within every bound", () => {
    expect(checkCaps(base)).toBeNull();
  });

  it("the agent's own max binds first", () => {
    expect(checkCaps({ ...base, amount: 30000n })).toBe("over_max_amount");
  });

  it("colony per-transaction and daily caps bind", () => {
    expect(checkCaps({ ...base, amount: 150000n, maxAmount: 200000n })).toBe("over_tx_cap");
    expect(checkCaps({ ...base, spentToday: 995000n })).toBe("over_daily_cap");
  });
});

describe("summarizeChallenge", () => {
  const CURRENCIES = parseCurrencyMap("0xToken=6");

  it("extracts the merchant tuple and display amount from the wire shape", () => {
    // The wire challenge carries NO decimals; they come from the map.
    const summary = summarizeChallenge("https://api.example.com/x", {
      method: "tempo",
      description: "Report",
      request: { amount: "10000", currency: "0xtoken", recipient: "0xABC" }
    }, CURRENCIES);
    expect(summary).toMatchObject({
      origin: "https://api.example.com",
      method: "tempo",
      recipient: "0xABC",
      currency: "0xtoken",
      amount: "10000",
      display: "0.01"
    });
  });

  it("returns null for missing facts or unknown assets (unreadable = unpayable)", () => {
    expect(
      summarizeChallenge("https://a.com/x", { method: "tempo", request: { amount: "1" } }, CURRENCIES)
    ).toBeNull();
    // An asset outside the known-currency map is unpayable.
    expect(
      summarizeChallenge("https://a.com/x", {
        method: "tempo",
        request: { amount: "1", recipient: "0xA", currency: "0xunknown" }
      }, CURRENCIES)
    ).toBeNull();
    expect(
      summarizeChallenge("https://a.com/x", {
        method: "tempo",
        request: { amount: "1.5", recipient: "0xA", currency: "0xtoken" }
      }, CURRENCIES)
    ).toBeNull();
  });

  it("parseCurrencyMap lowercases and validates decimals", () => {
    const map = parseCurrencyMap("0xAbC=6, 0xdef=18, bad, 0xz=99, 0xempty=, 0xneg=-1");
    expect(map.get("0xabc")).toBe(6);
    expect(map.get("0xdef")).toBe(18);
    // Empty, out-of-range, and non-digit decimals are all dropped.
    expect(map.size).toBe(2);
  });
});

describe("tupleKey and spendTokenVar", () => {
  it("binds origin, method, and case-insensitive recipient", () => {
    expect(
      tupleKey({ origin: "https://a.com", method: "tempo", recipient: "0xAbC" })
    ).toBe("https://a.com|tempo|0xabc");
  });

  it("maps agent ids to env names", () => {
    expect(spendTokenVar("promoter")).toBe("SPEND_TOKEN_PROMOTER");
  });
});

describe("allowanceMatches", () => {
  const NOW = "2026-08-30T12:00:00.000Z";
  const summary = {
    origin: "https://cairnwake.com",
    method: "tempo",
    recipient: "0x4F7975f4f00872517eb334420B7d5b673fcF2971",
    currency: "0x20C0000000000000000000000000000000000000",
    amount: "190200000",
    decimals: 6,
    display: "190.2"
  };
  const URL_A = "https://cairnwake.com/invoice/prior-audit";
  const allowance: Allowance = {
    id: "a1",
    agentId: "promoter",
    url: "https://cairnwake.com/invoice/prior-audit",
    origin: "https://cairnwake.com",
    method: "tempo",
    recipient: "0x4f7975f4f00872517eb334420b7d5b673fcf2971",
    currency: "0x20c0000000000000000000000000000000000000",
    maxAmount: "190200000",
    decimals: 6,
    display: "190.2",
    mintedAt: "2026-08-30T00:00:00.000Z",
    expiresAt: "2026-09-06T00:00:00.000Z"
  };

  it("matches the approved tuple case-insensitively on addresses, amount at the ceiling", () => {
    expect(allowanceMatches(allowance, "promoter", URL_A, summary, NOW)).toBe(true);
    expect(
      allowanceMatches(allowance, "promoter", URL_A, { ...summary, amount: "190199999" }, NOW)
    ).toBe(true);
  });

  it("refuses over-ceiling, wrong tuple, wrong currency, wrong agent", () => {
    expect(allowanceMatches(allowance, "promoter", URL_A, { ...summary, amount: "190200001" }, NOW)).toBe(false);
    expect(allowanceMatches(allowance, "promoter", URL_A, { ...summary, recipient: "0xdead" }, NOW)).toBe(false);
    expect(allowanceMatches(allowance, "promoter", URL_A, { ...summary, origin: "https://evil.com" }, NOW)).toBe(false);
    expect(allowanceMatches(allowance, "promoter", URL_A, { ...summary, method: "solana" }, NOW)).toBe(false);
    expect(allowanceMatches(allowance, "promoter", URL_A, { ...summary, currency: "0xother" }, NOW)).toBe(false);
    expect(allowanceMatches(allowance, "other-agent", URL_A, summary, NOW)).toBe(false);
  });

  it("binds to the approved URL: a same-shaped pay at another URL does not match", () => {
    expect(
      allowanceMatches(allowance, "promoter", "https://cairnwake.com/invoice/other", summary, NOW)
    ).toBe(false);
  });

  it("refuses an allowance whose expiry is already on the record, whatever the timestamp", () => {
    expect(
      allowanceMatches({ ...allowance, expiryLedgered: true }, "promoter", URL_A, summary, NOW)
    ).toBe(false);
  });

  it("refuses consumed, revoked, and expired allowances", () => {
    expect(allowanceMatches({ ...allowance, consumedAt: NOW }, "promoter", URL_A, summary, NOW)).toBe(false);
    expect(allowanceMatches({ ...allowance, revokedAt: NOW }, "promoter", URL_A, summary, NOW)).toBe(false);
    expect(
      allowanceMatches({ ...allowance, expiresAt: "2026-08-30T11:59:59.000Z" }, "promoter", URL_A, summary, NOW)
    ).toBe(false);
  });
});
