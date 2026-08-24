import { describe, expect, it } from "vitest";
import { findAgent, parseRoster, RosterError } from "./roster.js";

const valid = {
  zone: "example-colony.com",
  agents: [
    {
      id: "growth",
      stateRepo: "example-org/growth-state",
      cadence: "0 6,12,18 * * *",
      harness: "claude-code",
      model: "claude-sonnet-5",
      fallbackModel: "claude-haiku-4-5",
      hosts: ["@", "growth"],
      enabled: true
    }
  ]
};

describe("parseRoster", () => {
  it("parses a valid roster", () => {
    const roster = parseRoster(JSON.stringify(valid));
    expect(roster.zone).toBe("example-colony.com");
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0].hosts).toEqual(["@", "growth"]);
  });

  it("rejects non-JSON with a named error", () => {
    expect(() => parseRoster("not json")).toThrowError(RosterError);
    expect(() => parseRoster("not json")).toThrowError(/not valid JSON/);
  });

  it("names the failing field", () => {
    const broken = structuredClone(valid);
    broken.agents[0].stateRepo = "no-slash";
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(
      /agents\[0\]\.stateRepo/
    );
  });

  it("rejects invalid agent ids", () => {
    const broken = structuredClone(valid);
    broken.agents[0].id = "Bad_Id";
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(/agents\[0\]\.id/);
  });

  it("rejects invalid hosts", () => {
    const broken = structuredClone(valid);
    broken.agents[0].hosts = ["sub.domain"];
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(/hosts\[0\]/);
  });

  it("rejects empty hosts", () => {
    const broken = structuredClone(valid);
    broken.agents[0].hosts = [];
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(/hosts/);
  });

  it("accepts and validates maxWakeMinutes", () => {
    const withWall = structuredClone(valid) as {
      agents: Array<Record<string, unknown>>;
    };
    withWall.agents[0].maxWakeMinutes = 90;
    expect(parseRoster(JSON.stringify(withWall)).agents[0].maxWakeMinutes).toBe(90);

    withWall.agents[0].maxWakeMinutes = 0;
    expect(() => parseRoster(JSON.stringify(withWall))).toThrowError(
      /maxWakeMinutes/
    );
    withWall.agents[0].maxWakeMinutes = "60";
    expect(() => parseRoster(JSON.stringify(withWall))).toThrowError(
      /maxWakeMinutes/
    );
  });

  it("rejects duplicate agent ids", () => {
    const broken = structuredClone(valid);
    broken.agents.push(structuredClone(broken.agents[0]));
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(/duplicate/);
  });

  it("rejects a missing enabled flag rather than defaulting it", () => {
    const broken = structuredClone(valid) as {
      agents: Array<Record<string, unknown>>;
    };
    delete broken.agents[0].enabled;
    expect(() => parseRoster(JSON.stringify(broken))).toThrowError(/enabled/);
  });
});

describe("findAgent", () => {
  it("finds by id", () => {
    const roster = parseRoster(JSON.stringify(valid));
    expect(findAgent(roster, "growth")?.stateRepo).toBe("example-org/growth-state");
    expect(findAgent(roster, "missing")).toBeUndefined();
  });
});
