import { describe, expect, it } from "vitest";
import {
  EgressTableError,
  egressCredentialSecret,
  egressTableCredentials,
  parseEgressBlocklist,
  parseEgressTable,
  resolveEgressTable
} from "./egress.js";

const TABLE = JSON.stringify({
  "*": "http://${PROXY_GENERAL}@general.proxy.example:7777",
  "Docs.Example": "https://${PROXY_DOCS}@other.proxy.example",
  "*.registry.example": "direct",
  "open.example": "http://open.proxy.example:3128"
});

describe("parseEgressTable", () => {
  it("reads patterns, placeholders, bare addresses, and direct", () => {
    expect(parseEgressTable(TABLE)).toEqual([
      { pattern: "*", target: { address: "http://general.proxy.example:7777", credential: "PROXY_GENERAL" } },
      { pattern: "docs.example", target: { address: "https://other.proxy.example", credential: "PROXY_DOCS" } },
      { pattern: "*.registry.example", target: "direct" },
      { pattern: "open.example", target: { address: "http://open.proxy.example:3128" } }
    ]);
  });

  it("refuses a literal credential by name: credentials do not live in the table", () => {
    const literal = () => parseEgressTable('{"*": "http://user:secret@proxy.example:7777"}');
    expect(literal).toThrowError(EgressTableError);
    expect(literal).toThrowError(/egress_table_literal_credential/);
    expect(literal).toThrowError(/EGRESS_CREDENTIAL_NAME/);
    // A placeholder with a credential beside it is refused too.
    expect(() => parseEgressTable('{"*": "http://${A}@u:p@proxy.example"}')).toThrowError(
      /egress_table_invalid|egress_table_literal_credential/
    );
  });

  it("refuses malformed tables by name", () => {
    for (const bad of [
      "not json",
      "[]",
      "{}",
      '{"*": 7}',
      '{"bad host": "http://p.example"}',
      '{"*": "socks5://p.example"}',
      '{"*": "http://p.example/path"}',
      '{"*": "http://p.example:99999"}',
      '{"*": "http://${lower}@p.example"}'
    ]) {
      expect(() => parseEgressTable(bad)).toThrowError(/egress_table_invalid|egress_table_literal_credential/);
    }
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

describe("egressTableCredentials", () => {
  it("names each placeholder once, in table order", () => {
    expect(egressTableCredentials(TABLE)).toEqual(["PROXY_GENERAL", "PROXY_DOCS"]);
    expect(egressCredentialSecret("PROXY_GENERAL")).toBe("EGRESS_CREDENTIAL_PROXY_GENERAL");
    expect(egressTableCredentials('{"*": "direct"}')).toEqual([]);
  });
});

describe("resolveEgressTable", () => {
  const secrets: Record<string, string> = {
    EGRESS_CREDENTIAL_PROXY_GENERAL: "user:p@ss:w rd",
    EGRESS_CREDENTIAL_PROXY_DOCS: "useronly"
  };

  it("substitutes each secret, percent-encoded, and leaves the rest as written", () => {
    const resolved = JSON.parse(resolveEgressTable(TABLE, name => secrets[name])) as Record<string, string>;
    expect(resolved["*"]).toBe("http://user:p%40ss%3Aw%20rd@general.proxy.example:7777");
    expect(resolved["docs.example"]).toBe("https://useronly@other.proxy.example");
    expect(resolved["*.registry.example"]).toBe("direct");
    expect(resolved["open.example"]).toBe("http://open.proxy.example:3128");
    // The credential round-trips through a URL parser intact.
    const url = new URL(resolved["*"]);
    expect(decodeURIComponent(url.username)).toBe("user");
    expect(decodeURIComponent(url.password)).toBe("p@ss:w rd");
  });

  it("fails by name when a placeholder's secret is not configured", () => {
    const missing = () => resolveEgressTable(TABLE, name => (name === "EGRESS_CREDENTIAL_PROXY_DOCS" ? "x" : undefined));
    expect(missing).toThrowError(EgressTableError);
    expect(missing).toThrowError(/egress_credential_missing: secret EGRESS_CREDENTIAL_PROXY_GENERAL/);
  });
});
