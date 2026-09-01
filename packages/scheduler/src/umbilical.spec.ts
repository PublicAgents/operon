import { describe, expect, it } from "vitest";
import { doorHost, mcpHostsFor, resolveDoor, DOOR_ROUTES } from "./umbilical-routes.js";

const env = {
  NOTIFY_TOKEN: "notify-real",
  EMAIL_TOKEN: "email-real",
  PUBLISH_TOKEN: "publish-real",
  PERSIST_TOKEN: "persist-real",
  PR_TOKEN: "pr-real",
  CHRONICLE_TOKEN: "chronicle-real",
  TILL_TOKEN_PROMOTER: "till-promoter-real",
  SPEND_TOKEN_PROMOTER: "spend-promoter-real",
  VAULT_TOKEN_PROMOTER: "vault-promoter-real",
  X_TOKEN_PROMOTER: "x-promoter-real"
};

describe("umbilical door resolution", () => {
  it("maps a shared-bearer door to its binding and real bearer", () => {
    expect(resolveDoor("email.operon.internal", env, "promoter")).toEqual({
      binding: "EMAIL",
      bearer: "email-real"
    });
  });

  it("resolves the per-agent bearer for THIS container's agent", () => {
    expect(resolveDoor("spend.operon.internal", env, "promoter")).toEqual({
      binding: "SPEND",
      bearer: "spend-promoter-real"
    });
  });

  it("rejects a non-internal host, an unknown door, and a missing bearer", () => {
    expect(resolveDoor("api.anthropic.com", env, "promoter")).toEqual({ error: "not_internal" });
    expect(resolveDoor("nope.operon.internal", env, "promoter")).toEqual({ error: "unknown_door" });
    expect(resolveDoor("x.operon.internal", env, "other-agent")).toEqual({ error: "bearer_unconfigured" });
  });

  it("every door route names a binding and exactly one bearer source", () => {
    for (const [door, route] of Object.entries(DOOR_ROUTES)) {
      expect(route.binding, door).toBeTruthy();
      if (route.bearerless) {
        expect(Boolean(route.bearerEnv) || Boolean(route.perAgentPrefix), door).toBe(false);
      } else {
        expect(Boolean(route.bearerEnv) !== Boolean(route.perAgentPrefix), door).toBe(true);
      }
    }
  });

  it("a bearerless door resolves with no bearer at all", () => {
    expect(resolveDoor("web.operon.internal", {}, "promoter")).toEqual({ binding: "BROWSER" });
  });

  it("builds the virtual host for a door", () => {
    expect(doorHost("email")).toBe("email.operon.internal");
  });
});

describe("MCP routing (spec 0008 §4)", () => {
  const roster = JSON.stringify({
    zone: "demo-colony.com",
    mcp: {
      "google-analytics": { type: "gatekeeper", worker: "gatekeeper-google-analytics" },
      linear: { type: "portal", server: "linear" },
      plain: { type: "http", url: "https://mcp.example.com/mcp", auth: "none" }
    },
    agents: [
      {
        id: "promoter",
        stateRepo: "demo/state",
        cadence: "0 6 * * *",
        harness: "claude-code",
        model: "claude-fable-5",
        hosts: ["@"],
        enabled: true,
        mcp: ["google-analytics", "linear"]
      },
      {
        id: "second",
        stateRepo: "demo/second",
        cadence: "0 7 * * *",
        harness: "claude-code",
        model: "claude-fable-5",
        hosts: ["@"],
        enabled: true
      }
    ]
  });
  const mcpEnv = { ...env, ROSTER: roster };

  it("routes a bespoke gatekeeper server to its own binding", () => {
    expect(resolveDoor("mcp-google-analytics.operon.internal", mcpEnv, "promoter")).toEqual({
      binding: "MCP_GOOGLE_ANALYTICS"
    });
  });

  it("routes portal and plain remote servers to the generic proxy", () => {
    expect(resolveDoor("mcp-linear.operon.internal", mcpEnv, "promoter")).toEqual({
      binding: "MCP_GK"
    });
  });

  it("attaches no bearer: the binding is the authorization", () => {
    const resolved = resolveDoor("mcp-linear.operon.internal", mcpEnv, "promoter");
    expect("bearer" in resolved).toBe(false);
  });

  it("refuses a server this agent was not granted", () => {
    // Defined in the colony, but not in promoter's list.
    expect(resolveDoor("mcp-plain.operon.internal", mcpEnv, "promoter")).toEqual({
      error: "mcp_not_granted"
    });
    // Granted to nobody: another agent's request for promoter's server.
    expect(resolveDoor("mcp-linear.operon.internal", mcpEnv, "second")).toEqual({
      error: "mcp_not_granted"
    });
  });

  it("refuses an undefined server, and grants nothing without a roster", () => {
    expect(resolveDoor("mcp-ghost.operon.internal", mcpEnv, "promoter")).toEqual({
      error: "mcp_not_granted"
    });
    expect(resolveDoor("mcp-linear.operon.internal", env, "promoter")).toEqual({
      error: "mcp_not_granted"
    });
    expect(resolveDoor("mcp-linear.operon.internal", { ROSTER: "{bad" }, "promoter")).toEqual({
      error: "mcp_not_granted"
    });
  });

  it("lists exactly the granted hosts, for interception", () => {
    expect(mcpHostsFor(roster, "promoter")).toEqual([
      "mcp-google-analytics.operon.internal",
      "mcp-linear.operon.internal"
    ]);
    expect(mcpHostsFor(roster, "second")).toEqual([]);
  });
});
