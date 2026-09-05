import { describe, expect, it } from "vitest";
import {
  grantedRepos,
  mergeGrant,
  reachableRepos,
  reviewRepos,
  rosterAgentIds,
  rosterVerdict,
  type GrantSource
} from "./grants.js";

function roster(agents: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    zone: "demo-colony.com",
    agents: agents.map(agent => ({
      stateRepo: "demo/state",
      cadence: "0 6 * * *",
      harness: "claude-code",
      model: "claude-fable-5",
      hosts: ["@"],
      enabled: true,
      ...agent
    }))
  });
}

describe("grantedRepos (spec 0008 §3)", () => {
  it("gives each agent its own grant, not the fleet's", () => {
    const env: GrantSource = {
      PR_REPOS: "demo/everything",
      ROSTER: roster([
        { id: "scout", github: { pr: ["demo/product"] } },
        { id: "herald", github: { pr: ["demo/docs", "demo/product"] } }
      ])
    };
    expect(grantedRepos(env, "scout")).toEqual(["demo/product"]);
    expect(grantedRepos(env, "herald")).toEqual(["demo/docs", "demo/product"]);
  });

  it("falls back to the fleet list for an agent with no github block", () => {
    const env: GrantSource = {
      PR_REPOS: "demo/product, demo/docs",
      ROSTER: roster([{ id: "scout" }])
    };
    expect(grantedRepos(env, "scout")).toEqual(["demo/product", "demo/docs"]);
  });

  it("does not hand a write-only agent the fleet's PR list", () => {
    // The operator said what this agent may reach; a missing pr list
    // inside a github block means nothing, not "and also the fleet's".
    const env: GrantSource = {
      PR_REPOS: "demo/everything",
      ROSTER: roster([{ id: "scout", github: { write: ["demo/product"] } }])
    };
    expect(grantedRepos(env, "scout")).toEqual([]);
  });

  it("reads an explicit empty grant as nothing", () => {
    const env: GrantSource = {
      PR_REPOS: "demo/everything",
      ROSTER: roster([{ id: "scout", github: { pr: [] } }])
    };
    expect(grantedRepos(env, "scout")).toEqual([]);
  });

  it("grants nothing to an agent the roster does not know", () => {
    const env: GrantSource = { ROSTER: roster([{ id: "scout", github: { pr: ["demo/product"] } }]) };
    expect(grantedRepos(env, "stranger")).toEqual([]);
  });

  it("falls back rather than widening when the roster cannot be parsed", () => {
    // Defense in depth only: the doors refuse an unverifiable claim
    // before they ever ask for a grant (see rosterVerdict). If this is
    // ever reached, the fleet list is the narrower answer.
    const env: GrantSource = { PR_REPOS: "demo/product", ROSTER: "{not json" };
    expect(grantedRepos(env, "scout")).toEqual(["demo/product"]);
  });

  it("grants nothing when neither a grant nor a fleet list exists", () => {
    expect(grantedRepos({}, "scout")).toEqual([]);
  });
});

describe("rosterVerdict (an agent id is a claim)", () => {
  const env: GrantSource = { PR_REPOS: "demo/everything", ROSTER: roster([{ id: "scout" }]) };

  it("knows the roster's agents and refuses the rest", () => {
    expect(rosterVerdict(env, "scout")).toBe("known");
    expect(rosterVerdict(env, "stranger")).toBe("unknown");
  });

  it("cannot answer without a parseable roster, and says so", () => {
    // Distinct from "unknown" so the door can fail closed with the
    // right error: a missing ROSTER is a broken deployment, not a bad
    // request, and every Worker is deployed with one.
    expect(rosterVerdict({ PR_REPOS: "demo/x" }, "scout")).toBe("no-roster");
    expect(rosterVerdict({ ROSTER: "{not json" }, "scout")).toBe("no-roster");
  });
});

describe("reachable, review and merge grants (spec 0012 §3)", () => {
  const env: GrantSource = {
    PR_REPOS: "demo/everything",
    ROSTER: roster([
      { id: "researcher", github: { pr: ["demo/registry"] } },
      { id: "reviewer", github: { review: ["demo/registry"] } },
      {
        id: "cto",
        github: {
          pr: ["demo/site"],
          merge: [{ repo: "demo/registry", auto: ["registry/agents/**"], checks: ["validate"] }]
        }
      },
      { id: "legacy" }
    ])
  };

  it("lets a reviewer read what it adjudicates without an authoring grant", () => {
    expect(reachableRepos(env, "reviewer")).toEqual(["demo/registry"]);
    expect(grantedRepos(env, "reviewer")).toEqual([]);
    expect(reviewRepos(env, "reviewer")).toEqual(["demo/registry"]);
    expect(reviewRepos(env, "researcher")).toEqual([]);
  });

  it("unions pr and merge repos for the merger", () => {
    expect(reachableRepos(env, "cto")).toEqual(["demo/site", "demo/registry"]);
    expect(mergeGrant(env, "cto", "demo/registry")).toEqual({
      repo: "demo/registry",
      auto: ["registry/agents/**"],
      checks: ["validate"]
    });
    expect(mergeGrant(env, "cto", "demo/site")).toBeUndefined();
    expect(mergeGrant(env, "researcher", "demo/registry")).toBeUndefined();
  });

  it("keeps the fleet list for an agent without a github block, and nothing for a stranger", () => {
    expect(reachableRepos(env, "legacy")).toEqual(["demo/everything"]);
    expect(reachableRepos(env, "stranger")).toEqual(["demo/everything"]);
    expect(reviewRepos(env, "stranger")).toEqual([]);
    expect(rosterAgentIds(env)).toEqual(["researcher", "reviewer", "cto", "legacy"]);
    expect(rosterAgentIds({})).toEqual([]);
  });
});
