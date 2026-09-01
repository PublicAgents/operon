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

describe("capability grants (spec 0008)", () => {
  const granted = () => {
    const roster = structuredClone(valid) as Record<string, unknown> & {
      agents: Array<Record<string, unknown>>;
    };
    roster.mcp = {
      "google-analytics": { type: "gatekeeper", worker: "gatekeeper-google-analytics" },
      linear: { type: "portal", server: "linear", tools: ["linear_create_issue"] },
      plain: { type: "http", url: "https://mcp.example.com/mcp", auth: "bearer" },
      somelocal: { type: "stdio", command: "npx", args: ["-y", "some-mcp@1.2.3"] }
    };
    roster.agents[0].mcp = ["google-analytics", "linear"];
    roster.agents[0].github = {
      pr: ["example-org/product"],
      write: ["example-org/product"]
    };
    return roster;
  };

  it("parses every def type and the per-agent grants", () => {
    const roster = parseRoster(JSON.stringify(granted()));
    expect(Object.keys(roster.mcp ?? {})).toHaveLength(4);
    expect(roster.agents[0].mcp).toEqual(["google-analytics", "linear"]);
    expect(roster.agents[0].github?.write).toEqual(["example-org/product"]);
  });

  it("refuses an agent grant naming no defined server", () => {
    const roster = granted();
    (roster.agents[0].mcp as string[]).push("ghost");
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/names no server/);
  });

  it("refuses unknown keys in a def instead of dropping them", () => {
    const roster = granted();
    (roster.mcp as Record<string, Record<string, unknown>>).plain.headerSecret = "X";
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/headerSecret/);
  });

  it("refuses env on stdio by name: credential-less by construction", () => {
    const roster = granted();
    (roster.mcp as Record<string, Record<string, unknown>>).somelocal.env = { A: "1" };
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/stdio_env_unsupported/);
  });

  it("refuses an unpinned stdio package", () => {
    const roster = granted();
    (roster.mcp as Record<string, Record<string, unknown>>).somelocal.args = [
      "-y",
      "some-mcp@latest"
    ];
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/not pinned/);
  });

  it("never grants portal_* tools at any scope", () => {
    const roster = granted();
    (roster.mcp as Record<string, Record<string, unknown>>).linear.tools = ["portal_ls"];
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/never grantable/);
  });

  it("refuses portal server ids that prefix one another", () => {
    // "foo" vs "foo_bar": foo_bar_create would ride a grant for foo.
    const roster = granted();
    (roster.mcp as Record<string, unknown>).foo = { type: "portal", server: "foo" };
    (roster.mcp as Record<string, unknown>).foobar = { type: "portal", server: "foo_bar" };
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/portal_server_ambiguous/);
  });

  it("refuses malformed github grants and unknown grant keys", () => {
    const roster = granted();
    (roster.agents[0].github as Record<string, unknown>).write = ["not-a-repo"];
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/owner\/repo/);
    const roster2 = granted();
    (roster2.agents[0].github as Record<string, unknown>).push = ["a/b"];
    expect(() => parseRoster(JSON.stringify(roster2))).toThrowError(/not a github grant/);
  });

  it("refuses an unknown agent field instead of dropping it", () => {
    const roster = granted();
    roster.agents[0].mpc = ["google-analytics"];
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/mpc/);
  });

  it("refuses http urls that are not https", () => {
    const roster = granted();
    (roster.mcp as Record<string, Record<string, unknown>>).plain.url = "http://mcp.example.com";
    expect(() => parseRoster(JSON.stringify(roster))).toThrowError(/https/);
  });
});
