import { describe, expect, it } from "vitest";
import type { RosterAgent } from "@operon/core";
import { WAKE_ENV } from "@operon/core";
import {
  harnessExtraArgsVar,
  LaunchPreconditionError,
  mindCredentialVar,
  prepareLaunch,
  resolveMind,
  type LaunchContext
} from "./launch.js";
import { credentialFingerprint } from "./mind-credential.js";

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

describe("resolveMind (spec 0010 §4)", () => {
  const withAlternate: RosterAgent = { ...agent, harnesses: { codex: { model: "gpt-5.5" } } };

  it("runs the primary when no harness is named, or when the primary is named", () => {
    expect(resolveMind(withAlternate)).toEqual({
      harness: "claude-code",
      model: "claude-sonnet-5",
      fallbackModel: "claude-haiku-4-5"
    });
    expect(resolveMind(withAlternate, "claude-code").model).toBe("claude-sonnet-5");
  });

  it("runs a pinned alternate with its own model and no borrowed fallback", () => {
    expect(resolveMind(withAlternate, "codex")).toEqual({ harness: "codex", model: "gpt-5.5" });
  });

  it("refuses an unknown harness and an unpinned known one by name", () => {
    expect(() => resolveMind(withAlternate, "gemini")).toThrowError(/unknown_harness/);
    expect(() => resolveMind(agent, "codex")).toThrowError(/harness_not_configured/);
  });

  it("names the per-harness extra-args variable", () => {
    expect(harnessExtraArgsVar("claude-code")).toBe("HARNESS_EXTRA_ARGS");
    expect(harnessExtraArgsVar("codex")).toBe("HARNESS_EXTRA_ARGS_CODEX");
  });
});

describe("prepareLaunch on an alternate harness (spec 0010)", () => {
  const withAlternate: RosterAgent = { ...agent, harnesses: { codex: { model: "gpt-5.5" } } };
  const login = JSON.stringify({ tokens: { account_id: "acct-1", refresh_token: "r1" } });
  const secrets: Record<string, string> = {
    MIND_CREDENTIAL_CLAUDE_CODE: "mind-token",
    MIND_CREDENTIAL_CODEX: login,
    HARNESS_EXTRA_ARGS: '["--claude"]',
    HARNESS_EXTRA_ARGS_CODEX: '["--codex"]'
  };
  const codexContext = (overrides: Partial<LaunchContext> = {}) =>
    context({ getSecret: name => secrets[name], ...overrides });

  it("carries the alternate's mind, credential, and extra args, and opens the mind door for a file credential", async () => {
    const prepared = await prepareLaunch(withAlternate, "manual", "wake-c", codexContext(), "codex");
    expect(prepared.harness).toBe("codex");
    expect(prepared.env[WAKE_ENV.harness]).toBe("codex");
    expect(prepared.env[WAKE_ENV.model]).toBe("gpt-5.5");
    expect(prepared.env[WAKE_ENV.fallbackModel]).toBeUndefined();
    expect(prepared.env[WAKE_ENV.mindCredential]).toBe(login);
    expect(prepared.env[WAKE_ENV.harnessExtraArgs]).toBe('["--codex"]');
    expect(prepared.env[WAKE_ENV.mindUrl]).toBe("http://mind.operon.internal/credential");
    expect(prepared.env[WAKE_ENV.mindToken]).toBe(prepared.umbilicalNonce);
    expect(prepared.mindSeed).toEqual({ fingerprint: await credentialFingerprint(login), account: "acct-1" });
  });

  it("keeps the primary's extra args and opens no mind door for a token credential", async () => {
    const prepared = await prepareLaunch(withAlternate, "cron", "wake-p", codexContext());
    expect(prepared.harness).toBe("claude-code");
    expect(prepared.env[WAKE_ENV.harnessExtraArgs]).toBe('["--claude"]');
    expect(prepared.env[WAKE_ENV.mindUrl]).toBeUndefined();
    expect(prepared.mindSeed.account).toBeUndefined();
  });

  it("prefers a relayed credential only while it descends from the current secret", async () => {
    const fingerprint = await credentialFingerprint(login);
    const fresh = await prepareLaunch(withAlternate, "manual", "w1", codexContext({
      getRefreshedCredential: async () => ({ seed: fingerprint, value: "refreshed-login" })
    }), "codex");
    expect(fresh.env[WAKE_ENV.mindCredential]).toBe("refreshed-login");
    const orphaned = await prepareLaunch(withAlternate, "manual", "w2", codexContext({
      getRefreshedCredential: async () => ({ seed: "older-seed", value: "refreshed-login" })
    }), "codex");
    expect(orphaned.env[WAKE_ENV.mindCredential]).toBe(login);
  });

  it("refuses an alternate the roster did not pin, before any secret is read", async () => {
    await expect(prepareLaunch(agent, "manual", "w3", codexContext(), "codex")).rejects.toThrowError(
      /harness_not_configured/
    );
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
