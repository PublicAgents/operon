import { describe, expect, it } from "vitest";
import { grantedRepos, type GrantSource } from "./grants.js";

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
    // A broken roster must never mean "everything": the fleet list is
    // what this Worker enforced before grants existed.
    const env: GrantSource = { PR_REPOS: "demo/product", ROSTER: "{not json" };
    expect(grantedRepos(env, "scout")).toEqual(["demo/product"]);
  });

  it("grants nothing when neither a grant nor a fleet list exists", () => {
    expect(grantedRepos({}, "scout")).toEqual([]);
  });
});
