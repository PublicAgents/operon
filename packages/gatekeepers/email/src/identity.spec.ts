import { describe, expect, it } from "vitest";
import { parseRoster } from "@operon/core";
import { identityForAgent, identityForRecipient } from "./identity.js";

const roster = parseRoster(
  JSON.stringify({
    zone: "example-colony.com",
    agents: [
      {
        id: "promoter",
        stateRepo: "example-org/promoter-state",
        cadence: "0 6 * * *",
        harness: "claude-code",
        model: "m",
        hosts: ["@", "prior"],
        enabled: true
      }
    ]
  })
);

const DOMAIN = "agents.example-colony.com";

describe("identityForAgent", () => {
  it("derives the address, name, and site from the subdomain host", () => {
    const id = identityForAgent(roster.agents[0], DOMAIN, roster.zone);
    expect(id).toEqual({
      agentId: "promoter",
      localPart: "prior",
      address: "prior@agents.example-colony.com",
      name: "Prior",
      siteUrl: "https://prior.example-colony.com"
    });
  });
});

describe("identityForRecipient", () => {
  it("maps a recipient local part back to its agent", () => {
    expect(identityForRecipient(roster, DOMAIN, "prior@agents.example-colony.com")?.agentId).toBe(
      "promoter"
    );
    expect(identityForRecipient(roster, DOMAIN, "Prior@Agents.Example-Colony.com")?.agentId).toBe(
      "promoter"
    );
  });

  it("rejects unknown local parts and foreign domains", () => {
    expect(identityForRecipient(roster, DOMAIN, "nobody@agents.example-colony.com")).toBeNull();
    expect(identityForRecipient(roster, DOMAIN, "prior@example.com")).toBeNull();
  });
});
