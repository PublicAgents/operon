import { describe, expect, it } from "vitest";
import type { RosterAgent } from "@operon/core";
import { WAKE_ENV } from "@operon/core";
import {
  LaunchPreconditionError,
  mindCredentialVar,
  prepareLaunch,
  type LaunchContext
} from "./launch.js";

const agent: RosterAgent = {
  id: "growth",
  stateRepo: "example-org/growth-state",
  cadence: "0 6 * * *",
  harness: "claude-code",
  model: "claude-sonnet-5",
  fallbackModel: "claude-haiku-4-5",
  hosts: ["@"],
  enabled: true
};

function context(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    getSecret: name => (name === "MIND_CREDENTIAL_CLAUDE_CODE" ? "mind-token" : undefined),
    getGithubToken: async () => "gh-token",
    options: { notifyUrl: "https://tg/notify", notifyToken: "nt", secretDenylist: "a,b" },
    ...overrides
  };
}

describe("mindCredentialVar", () => {
  it("maps harness ids to secret names", () => {
    expect(mindCredentialVar("claude-code")).toBe("MIND_CREDENTIAL_CLAUDE_CODE");
    expect(mindCredentialVar("codex")).toBe("MIND_CREDENTIAL_CODEX");
  });
});

describe("prepareLaunch", () => {
  it("assembles the full wake environment", async () => {
    const prepared = await prepareLaunch(agent, "cron", "wake-1", context());
    expect(prepared.env[WAKE_ENV.agentId]).toBe("growth");
    expect(prepared.env[WAKE_ENV.wakeId]).toBe("wake-1");
    expect(prepared.env[WAKE_ENV.trigger]).toBe("cron");
    expect(prepared.env[WAKE_ENV.stateRepo]).toBe("example-org/growth-state");
    expect(prepared.env[WAKE_ENV.model]).toBe("claude-sonnet-5");
    expect(prepared.env[WAKE_ENV.fallbackModel]).toBe("claude-haiku-4-5");
    expect(prepared.env[WAKE_ENV.githubToken]).toBe("gh-token");
    expect(prepared.env[WAKE_ENV.mindCredential]).toBe("mind-token");
    expect(prepared.env[WAKE_ENV.secretDenylist]).toBe("a,b");
    expect(prepared.env[WAKE_ENV.maxWakeMinutes]).toBe("120");
    // The umbilical (spec 0003 step 4): the door URL is a virtual host and
    // the door token is the per-wake nonce, never a real bearer.
    // The umbilical: door URLs are virtual hosts, tokens are the nonce.
    // The direct-call doors (notify/publish/persist) carry their route in
    // the URL; the rest are bases their callers append paths to.
    expect(prepared.env[WAKE_ENV.notifyUrl]).toBe("http://notify.operon.internal/notify");
    expect(prepared.env[WAKE_ENV.publishUrl]).toBe("http://publish.operon.internal/gatekeeper/publish");
    expect(prepared.env[WAKE_ENV.persistUrl]).toBe("http://persist.operon.internal/commit");
    expect(prepared.env[WAKE_ENV.prUrl]).toBe("http://pr.operon.internal/gatekeeper/pr");
    expect(prepared.env[WAKE_ENV.emailUrl]).toBe("http://email.operon.internal");
    expect(prepared.env[WAKE_ENV.notifyToken]).toBe(prepared.umbilicalNonce);
    expect(prepared.umbilicalNonce).toMatch(/[0-9a-f-]{36}/);
    // The web door is opt-in: this agent is not web-capable.
    expect(prepared.env[WAKE_ENV.webUrl]).toBeUndefined();
  });

  it("substitutes the outbound proxy table's placeholders from secrets, and fails by name without one", async () => {
    const table = JSON.stringify({
      proxies: { general: { address: "http://general.proxy.example:7777", credential: "PROXY_GENERAL" } },
      routes: { "*": "general", "*.registry.example": "direct" }
    });
    const withSecret = context({
      getSecret: name =>
        name === "MIND_CREDENTIAL_CLAUDE_CODE"
          ? "mind-token"
          : name === "EGRESS_CREDENTIAL_PROXY_GENERAL"
            ? "user:p@ss"
            : undefined,
      options: { egressProxy: table, egressBlocklist: '["*.ads.example"]' }
    });
    const prepared = await prepareLaunch(agent, "cron", "wake-proxy", withSecret);
    expect(prepared.env[WAKE_ENV.egressBlocklist]).toBe('["*.ads.example"]');
    expect(JSON.parse(prepared.env[WAKE_ENV.egressProxy] as string)).toEqual({
      proxies: { general: "http://user:p%40ss@general.proxy.example:7777" },
      routes: { "*": "general", "*.registry.example": "direct" }
    });
    // The committed table never carried the value.
    expect(table).not.toContain("p@ss");

    const missing = context({ options: { egressProxy: table } });
    await expect(prepareLaunch(agent, "cron", "wake-proxy-missing", missing)).rejects.toMatchObject({
      name: "LaunchPreconditionError",
      code: "egress_credential_missing"
    });
    // No table, no variable: the container defaults to all-direct.
    const none = await prepareLaunch(agent, "cron", "wake-no-proxy", context());
    expect(none.env[WAKE_ENV.egressProxy]).toBeUndefined();
  });

  it("wires the web door for a web-capable agent", async () => {
    const webAgent = { ...agent, web: true };
    const prepared = await prepareLaunch(webAgent, "cron", "wake-web", context());
    expect(prepared.env[WAKE_ENV.webUrl]).toBe("http://web.operon.internal");
    expect(prepared.env[WAKE_ENV.webToken]).toBe(prepared.umbilicalNonce);
  });

  it("carries the agent's own GitHub grants into the wake", async () => {
    const granted = {
      ...agent,
      github: { pr: ["demo/product"], write: ["demo/product"] }
    };
    const prepared = await prepareLaunch(granted, "cron", "wake-grants", context());
    expect(JSON.parse(prepared.env[WAKE_ENV.githubGrants] as string)).toEqual({
      pr: ["demo/product"],
      write: ["demo/product"]
    });
    // A write-only grant still carries an explicit empty pr list, so
    // the container refuses PR repos the Gatekeeper would also refuse.
    const writeOnly = await prepareLaunch(
      { ...agent, github: { write: ["demo/product"] } },
      "cron",
      "wake-write",
      context()
    );
    expect(JSON.parse(writeOnly.env[WAKE_ENV.githubGrants] as string)).toEqual({
      pr: [],
      write: ["demo/product"]
    });
    // An agent with no github block carries no variable at all, so the
    // porch falls back to the fleet list rather than reading a missing
    // grant as "granted nothing".
    const plain = await prepareLaunch(agent, "cron", "wake-plain", context());
    expect(plain.env[WAKE_ENV.githubGrants]).toBeUndefined();
  });

  it("fails closed with a named error when the mind credential is missing", async () => {
    const missing = context({ getSecret: () => undefined });
    await expect(prepareLaunch(agent, "cron", "wake-1", missing)).rejects.toThrowError(
      LaunchPreconditionError
    );
    await expect(prepareLaunch(agent, "cron", "wake-1", missing)).rejects.toThrowError(
      /mind_credential_missing.*MIND_CREDENTIAL_CLAUDE_CODE/
    );
  });

  it("propagates github token failures", async () => {
    const failing = context({
      getGithubToken: async () => {
        throw new LaunchPreconditionError("github_token_mint_failed", "boom");
      }
    });
    await expect(prepareLaunch(agent, "manual", "wake-2", failing)).rejects.toThrowError(
      /github_token_mint_failed/
    );
  });
});

describe("the doors matrix at launch (spec 0006 §7)", () => {
  it("does not wire a closed door, names the closed doors, and drops MCP servers when that door is closed", async () => {
    const fenced = {
      ...agent,
      web: true,
      mcp: ["google-analytics"],
      doors: { x: false }
    };
    const prepared = await prepareLaunch(fenced, "cron", "wake-doors", context({
      getSecret: name =>
        name === "MIND_CREDENTIAL_CLAUDE_CODE" ? "mind-token" : name.startsWith("X_TOKEN_") ? "x-real" : undefined,
      getDoorOverrides: async () => ({ pay: false, mcp: false, web: false })
    }));
    // The roster closed x; the operator closed pay, mcp and web.
    expect(prepared.env.OPERON_X_URL).toBeUndefined();
    expect(prepared.env.OPERON_X_TOKEN).toBeUndefined();
    expect(prepared.env.OPERON_SPEND_URL).toBeUndefined();
    expect(prepared.env.OPERON_WEB_URL).toBeUndefined();
    expect(prepared.env.OPERON_MCP_SERVERS).toBeUndefined();
    expect(prepared.mcpHosts).toEqual([]);
    // Open doors are wired as before; the plumbing never closes.
    expect(prepared.env.OPERON_NOTIFY_URL).toBeDefined();
    expect(prepared.env.OPERON_PERSIST_URL).toBeDefined();
    expect(JSON.parse(prepared.env.OPERON_DISABLED_DOORS ?? "[]").sort()).toEqual(["mcp", "pay", "web", "x"]);
    // The router is told every closed door, so a guessed host is refused outside the container.
    expect([...prepared.closedDoors].sort()).toEqual(["mcp", "pay", "web", "x"]);
  });

  it("a closed GitHub door withholds the grants the branch door pre-checks", async () => {
    const granted = {
      ...agent,
      github: { pr: ["o/one"], write: ["o/one"] },
      doors: { github: false }
    };
    const prepared = await prepareLaunch(granted, "cron", "wake-gh-closed", context());
    expect(prepared.env.OPERON_PR_URL).toBeUndefined();
    expect(JSON.parse(prepared.env.OPERON_GITHUB_GRANTS ?? "{}")).toEqual({ pr: [], write: [] });
    // The state commit is plumbing and stays wired.
    expect(prepared.env.OPERON_PERSIST_URL).toBeDefined();
    expect(prepared.closedDoors).toContain("github");
  });

  it("wires every door when nothing is closed, and says nothing about doors", async () => {
    const prepared = await prepareLaunch(agent, "cron", "wake-open", context());
    expect(prepared.env.OPERON_DISABLED_DOORS).toBeUndefined();
    expect(prepared.env.OPERON_X_URL).toBeDefined();
  });
});
