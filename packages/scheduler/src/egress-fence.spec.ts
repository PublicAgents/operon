import { describe, expect, it } from "vitest";
import { fenceAllowedHosts, parseExtraHosts } from "./egress-fence.js";

describe("the web door egress fence", () => {
  const hosts = fenceAllowedHosts();

  it("allows the minimal wake infra the process itself needs", () => {
    expect(hosts).toContain("api.anthropic.com");
    expect(hosts).toContain("github.com");
    expect(hosts).toContain("registry.npmjs.org");
  });

  it("never allows a browsing target: browsing is remote", () => {
    // A site the mind visits goes relay -> Browser Run, never container
    // egress, so it must not appear here (and could not be known anyway).
    expect(hosts).not.toContain("example.com");
    expect(hosts.some(host => host.includes("trycloudflare"))).toBe(false);
  });

  it("allows the tunnel INGRESS, never the public tunnel hostname", () => {
    // cloudflared dials argotunnel; *.trycloudflare.com is what the
    // REMOTE browser reaches, and allowing it would admit an attacker's
    // own tunnel as an exfil sink.
    expect(hosts).toContain("*.argotunnel.com");
  });

  it("is deduplicated and stable", () => {
    expect(new Set(hosts).size).toBe(hosts.length);
    expect([...hosts].sort()).toEqual(hosts);
  });

  it("takes operator-supplied extras, never mind-supplied ones", () => {
    const withExtra = fenceAllowedHosts(["api.stripe.com"]);
    expect(withExtra).toContain("api.stripe.com");
  });

  it("parses the operator's extra-hosts list forgivingly", () => {
    expect(parseExtraHosts("a.com, b.com ,")).toEqual(["a.com", "b.com"]);
    expect(parseExtraHosts(undefined)).toEqual([]);
    expect(parseExtraHosts("")).toEqual([]);
  });
});
