import { describe, expect, it } from "vitest";
import { parseRoster } from "@operon/core";
import { identityForAgent, identityForRecipient } from "./identity.js";

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

const DOMAIN = "agents.livevariant.ai";

describe("identityForAgent", () => {
  it("derives the address, name, and site from the subdomain host", () => {
    const id = identityForAgent(roster.agents[0], DOMAIN, roster.zone);
    expect(id).toEqual({
      agentId: "promoter",
      localPart: "prior",
      address: "prior@agents.livevariant.ai",
      name: "Prior",
      siteUrl: "https://prior.livevariant.ai"
    });
  });
});

describe("identityForRecipient", () => {
  it("maps a recipient local part back to its agent", () => {
    expect(identityForRecipient(roster, DOMAIN, "prior@agents.livevariant.ai")?.agentId).toBe(
      "promoter"
    );
    expect(identityForRecipient(roster, DOMAIN, "Prior@Agents.LiveVariant.ai")?.agentId).toBe(
      "promoter"
    );
  });

  it("rejects unknown local parts and foreign domains", () => {
    expect(identityForRecipient(roster, DOMAIN, "nobody@agents.livevariant.ai")).toBeNull();
    expect(identityForRecipient(roster, DOMAIN, "prior@example.com")).toBeNull();
  });
});
