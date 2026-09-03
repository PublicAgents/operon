import { describe, expect, it } from "vitest";
import type { RosterAgent } from "./roster.js";
import { WAKE_ENV, wakeEnv } from "./wake.js";

const agent: RosterAgent = {
  id: "a",
  stateRepo: "o/r",
  cadence: "0 6 * * *",
  harness: "claude-code",
  model: "claude-sonnet-5",
  fallbackModel: "claude-haiku-4-5",
  hosts: ["@"],
  enabled: true,
  harnesses: { codex: { model: "gpt-5.5" } }
};

describe("wakeEnv (spec 0010 §4)", () => {
  it("carries the resolved mind, not the agent's primary", () => {
    const env = wakeEnv(
      { wakeId: "w", trigger: "manual", agent, mind: { harness: "codex", model: "gpt-5.5" } },
      { githubToken: "g", mindCredential: "c" }
    );
    expect(env[WAKE_ENV.harness]).toBe("codex");
    expect(env[WAKE_ENV.model]).toBe("gpt-5.5");
    expect(env[WAKE_ENV.fallbackModel]).toBeUndefined();
  });
});
