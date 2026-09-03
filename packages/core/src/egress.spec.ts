import { describe, expect, it } from "vitest";
import {
  EgressTableError,
  egressCredentialSecret,
  egressPolicyCredentials,
  parseEgressBlocklist,
  parseEgressPolicy,
  resolveEgressPolicy
} from "./egress.js";

const POLICY = {
  proxies: {
    general: { address: "http://general.proxy.example:7777", credential: "PROXY_GENERAL" },
    docs: { address: "https://other.proxy.example", credential: "PROXY_DOCS" },
    open: { address: "http://open.proxy.example:3128" }
  },
  routes: {
    "*": "general",
    "Docs.Example": "docs",
    "*.registry.example": "direct",
    "open.example": "open"
  }
};

describe("parseEgressPolicy", () => {
  it("reads named proxies and the routes that reference them, from an object or JSON", () => {
    const expected = {
      proxies: POLICY.proxies,
      routes: { "*": "general", "docs.example": "docs", "*.registry.example": "direct", "open.example": "open" }
    };
    expect(parseEgressPolicy(POLICY)).toEqual(expected);
    expect(parseEgressPolicy(JSON.stringify(POLICY))).toEqual(expected);
    expect(parseEgressPolicy({})).toEqual({ proxies: {}, routes: {} });
  });

  it("refuses a literal credential by name: credentials do not live in the manifest", () => {
    const literal = () =>
      parseEgressPolicy({ proxies: { p: { address: "http://user:secret@proxy.example:7777" } }, routes: {} });
    expect(literal).toThrowError(EgressTableError);
    expect(literal).toThrowError(/egress_policy_literal_credential/);
    expect(literal).toThrowError(/EGRESS_CREDENTIAL_NAME/);
  });

  it("refuses malformed policies by name", () => {
    for (const bad of [
      "not json",
      [],
      { extra: 1 },
      { proxies: { "Bad Name": { address: "http://p.example" } } },
      { proxies: { p: { address: 7 } } },
      { proxies: { p: { address: "socks5://p.example" } } },
      { proxies: { p: { address: "http://p.example/path" } } },
      { proxies: { p: { address: "http://p.example:99999" } } },
      { proxies: { p: { address: "http://p.example", credential: "lower" } } },
      { proxies: { p: { address: "http://p.example", other: 1 } } },
      { routes: { "bad host": "direct" } },
      { routes: { "*": 7 } },
      { routes: { "*": "nowhere" } }
    ]) {
      expect(() => parseEgressPolicy(bad)).toThrowError(/egress_policy_invalid|egress_policy_literal_credential/);
    }
  });
});

describe("egressPolicyCredentials", () => {
  it("names each credential once, in definition order", () => {
    expect(egressPolicyCredentials(parseEgressPolicy(POLICY))).toEqual(["PROXY_GENERAL", "PROXY_DOCS"]);
    expect(egressCredentialSecret("PROXY_GENERAL")).toBe("EGRESS_CREDENTIAL_PROXY_GENERAL");
    expect(egressPolicyCredentials(parseEgressPolicy({}))).toEqual([]);
  });
});

describe("resolveEgressPolicy", () => {
  const secrets: Record<string, string> = {
    EGRESS_CREDENTIAL_PROXY_GENERAL: "user:p@ss:w rd",
    EGRESS_CREDENTIAL_PROXY_DOCS: "useronly"
  };

  it("substitutes each secret, percent-encoded, and leaves the rest as written", () => {
    const resolved = JSON.parse(resolveEgressPolicy(parseEgressPolicy(POLICY), name => secrets[name])) as {
      proxies: Record<string, string>;
      routes: Record<string, string>;
    };
    expect(resolved.proxies.general).toBe("http://user:p%40ss%3Aw%20rd@general.proxy.example:7777");
    expect(resolved.proxies.docs).toBe("https://useronly@other.proxy.example");
    expect(resolved.proxies.open).toBe("http://open.proxy.example:3128");
    expect(resolved.routes).toEqual({
      "*": "general",
      "docs.example": "docs",
      "*.registry.example": "direct",
      "open.example": "open"
    });
    // The credential round-trips through a URL parser intact.
    const url = new URL(resolved.proxies.general);
    expect(decodeURIComponent(url.username)).toBe("user");
    expect(decodeURIComponent(url.password)).toBe("p@ss:w rd");
  });

  it("fails by name when a named credential's secret is not configured", () => {
    const missing = () =>
      resolveEgressPolicy(parseEgressPolicy(POLICY), name => (name === "EGRESS_CREDENTIAL_PROXY_DOCS" ? "x" : undefined));
    expect(missing).toThrowError(EgressTableError);
    expect(missing).toThrowError(/egress_credential_missing: secret EGRESS_CREDENTIAL_PROXY_GENERAL/);
  });
});

describe("parseEgressBlocklist", () => {
  it("normalises host patterns and refuses anything else by name", () => {
    expect(parseEgressBlocklist([" Tracker.Example ", "*.ads.example", "*", "tracker.example"])).toEqual([
      "tracker.example",
      "*.ads.example",
      "*"
    ]);
    expect(parseEgressBlocklist([])).toEqual([]);
    for (const bad of ["not a list", [7], ["bad host"], ["http://host.example"]]) {
      expect(() => parseEgressBlocklist(bad)).toThrowError(/egress_blocklist_invalid/);
    }
  });
});
