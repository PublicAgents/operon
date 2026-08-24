import { describe, expect, it } from "vitest";
import { distinctCadences, dueAgents, normalizeCadence } from "./cadence.js";
import type { Roster, RosterAgent } from "./roster.js";

function agent(overrides: Partial<RosterAgent>): RosterAgent {
  return {
    id: "a",
    stateRepo: "org/a-state",
    cadence: "0 6 * * *",
    harness: "claude-code",
    model: "claude-sonnet-5",
    hosts: ["a"],
    enabled: true,
    ...overrides
  };
}

function roster(agents: RosterAgent[]): Roster {
  return { zone: "example-colony.com", agents };
}

describe("normalizeCadence", () => {
  it("collapses whitespace only", () => {
    expect(normalizeCadence("  0   6 * * *  ")).toBe("0 6 * * *");
  });
});

describe("dueAgents", () => {
  it("matches by normalized cadence", () => {
    const agents = [
      agent({ id: "a", cadence: "0 6 * * *" }),
      agent({ id: "b", cadence: "0  6 * * *" }),
      agent({ id: "c", cadence: "0 12 * * *" })
    ];
    const due = dueAgents(roster(agents), "0 6 * * *");
    expect(due.map(a => a.id)).toEqual(["a", "b"]);
  });

  it("skips disabled agents", () => {
    const agents = [agent({ id: "a", enabled: false })];
    expect(dueAgents(roster(agents), "0 6 * * *")).toEqual([]);
  });
});

describe("distinctCadences", () => {
  it("lists each enabled cadence once", () => {
    const agents = [
      agent({ id: "a", cadence: "0 6 * * *" }),
      agent({ id: "b", cadence: "0   6 * * *" }),
      agent({ id: "c", cadence: "0 12 * * *", enabled: false })
    ];
    expect(distinctCadences(roster(agents))).toEqual(["0 6 * * *"]);
  });
});
