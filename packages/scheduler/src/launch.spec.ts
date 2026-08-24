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
    expect(prepared.env[WAKE_ENV.notifyUrl]).toBe("https://tg/notify");
    expect(prepared.env[WAKE_ENV.secretDenylist]).toBe("a,b");
    expect(prepared.env[WAKE_ENV.maxWakeMinutes]).toBe("120");
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
