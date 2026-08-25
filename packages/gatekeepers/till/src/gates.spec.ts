import { describe, expect, it } from "vitest";
import { parseRoster } from "@operon/core";
import { agentHostnames, comparePrices, tokenEnvName, validateOffer, withinOfferCap, type Offer } from "./gates.js";

const roster = parseRoster(
  JSON.stringify({
    zone: "livevariant.ai",
    agents: [
      {
        id: "promoter",
        stateRepo: "livevariant/promoter-state",
        cadence: "0 6 * * *",
        harness: "claude-code",
        model: "m",
        hosts: ["@", "prior"],
        enabled: true
      }
    ]
  })
);
const agent = roster.agents[0];
const LIMITS = { maxPrice: "1.00", maxOffers: 3, currencies: ["0xtoken"] };

function offer(overrides: Partial<Parameters<typeof validateOffer>[0]> = {}) {
  return {
    host: "prior.livevariant.ai",
    path: "/reports/weekly.html",
    price: "0.05",
    currency: "0xtoken",
    description: "Weekly report",
    ...overrides
  };
}

describe("agentHostnames", () => {
  it("resolves @ to the zone and labels to subdomains", () => {
    expect(agentHostnames(agent, roster.zone)).toEqual(["livevariant.ai", "prior.livevariant.ai"]);
  });
});

describe("validateOffer", () => {
  it("accepts a well-formed offer within ceilings", () => {
    expect(validateOffer(offer(), agent, roster, LIMITS)).toBeNull();
  });

  it("rejects hosts the agent is not assigned", () => {
    expect(validateOffer(offer({ host: "other.livevariant.ai" }), agent, roster, LIMITS)).toBe(
      "host_not_assigned"
    );
  });

  it("rejects chassis paths, traversal, and malformed paths", () => {
    expect(validateOffer(offer({ path: "/gatekeeper/publish" }), agent, roster, LIMITS)).toBe(
      "reserved_path"
    );
    expect(validateOffer(offer({ path: "/a/../b" }), agent, roster, LIMITS)).toBe("invalid_path");
    expect(validateOffer(offer({ path: "no-slash" }), agent, roster, LIMITS)).toBe("invalid_path");
  });

  it("enforces the price ceiling without floating point", () => {
    expect(validateOffer(offer({ price: "1.00" }), agent, roster, LIMITS)).toBeNull();
    expect(validateOffer(offer({ price: "1.000001" }), agent, roster, LIMITS)).toBe(
      "price_above_ceiling"
    );
    expect(validateOffer(offer({ price: "0.1e3" }), agent, roster, LIMITS)).toBe("invalid_price");
  });

  it("rejects currencies outside the colony allowlist", () => {
    expect(validateOffer(offer({ currency: "0xevil" }), agent, roster, LIMITS)).toBe(
      "currency_not_allowed"
    );
  });

  it("leaves the count cap to the DO (withinOfferCap)", () => {
    const mine = (path: string): Offer => ({ agentId: "promoter", ...offer({ path }) });
    const existing = [mine("/a"), mine("/b"), mine("/c")];
    expect(withinOfferCap(existing, mine("/d"), 3)).toBe(false);
    // Updating an existing path is not a new slot.
    expect(withinOfferCap(existing, mine("/a"), 3)).toBe(true);
    // Another agent's offers do not count against this agent.
    const foreign: Offer = { ...mine("/x"), agentId: "other" };
    expect(withinOfferCap([...existing.slice(0, 2), foreign], mine("/d"), 3)).toBe(true);
  });
});

describe("comparePrices", () => {
  it("compares decimal strings exactly", () => {
    expect(comparePrices("0.10", "0.1")).toBe(0);
    expect(comparePrices("0.2", "0.15")).toBe(1);
    expect(comparePrices("1", "1.000001")).toBe(-1);
  });
});

describe("tokenEnvName", () => {
  it("maps agent ids to env names", () => {
    expect(tokenEnvName("promoter")).toBe("TILL_TOKEN_PROMOTER");
    expect(tokenEnvName("side-kick")).toBe("TILL_TOKEN_SIDE_KICK");
  });
});
