import { describe, expect, it } from "vitest";
import { parseRoster } from "@operon/core";
import { agentHostnames, comparePrices, tokenEnvName, validateOffer } from "./gates.js";

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
    expect(validateOffer(offer(), agent, roster, LIMITS, 0)).toBeNull();
  });

  it("rejects hosts the agent is not assigned", () => {
    expect(validateOffer(offer({ host: "other.livevariant.ai" }), agent, roster, LIMITS, 0)).toBe(
      "host_not_assigned"
    );
  });

  it("rejects chassis paths, traversal, and malformed paths", () => {
    expect(validateOffer(offer({ path: "/gatekeeper/publish" }), agent, roster, LIMITS, 0)).toBe(
      "reserved_path"
    );
    expect(validateOffer(offer({ path: "/a/../b" }), agent, roster, LIMITS, 0)).toBe("invalid_path");
    expect(validateOffer(offer({ path: "no-slash" }), agent, roster, LIMITS, 0)).toBe("invalid_path");
  });

  it("enforces the price ceiling without floating point", () => {
    expect(validateOffer(offer({ price: "1.00" }), agent, roster, LIMITS, 0)).toBeNull();
    expect(validateOffer(offer({ price: "1.000001" }), agent, roster, LIMITS, 0)).toBe(
      "price_above_ceiling"
    );
    expect(validateOffer(offer({ price: "0.1e3" }), agent, roster, LIMITS, 0)).toBe("invalid_price");
  });

  it("rejects currencies outside the colony allowlist", () => {
    expect(validateOffer(offer({ currency: "0xevil" }), agent, roster, LIMITS, 0)).toBe(
      "currency_not_allowed"
    );
  });

  it("caps the offer count, counting only OTHER offers", () => {
    expect(validateOffer(offer(), agent, roster, LIMITS, 3)).toBe("too_many_offers");
    expect(validateOffer(offer(), agent, roster, LIMITS, 2)).toBeNull();
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
