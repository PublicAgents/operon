import { describe, expect, it } from "vitest";
import { WAKE_ENV } from "@operon/core";
import { ConfigError, ENV, readWakeConfig } from "./config.js";

describe("ENV contract", () => {
  it("matches @operon/core's WAKE_ENV exactly, both directions", () => {
    // The names are duplicated because the Docker build context cannot see
    // other packages; this test is what turns drift into a red build.
    expect(ENV).toEqual(WAKE_ENV);
  });
});

const complete: Record<string, string> = {
  OPERON_WAKE_ID: "w1",
  OPERON_AGENT_ID: "growth",
  OPERON_TRIGGER: "cron",
  OPERON_STATE_REPO: "org/growth-state",
  OPERON_HARNESS: "claude-code",
  OPERON_MODEL: "claude-sonnet-5",
  OPERON_GITHUB_TOKEN: "gh",
  OPERON_MIND_CREDENTIAL: "mind"
};

describe("readWakeConfig", () => {
  it("reads a complete config", () => {
    const config = readWakeConfig({
      ...complete,
      OPERON_FALLBACK_MODEL: "claude-haiku-4-5",
      OPERON_SECRET_DENYLIST: " tok1 , tok2 ,",
      OPERON_HARNESS_EXTRA_ARGS: '["--flag","value"]'
    });
    expect(config.agentId).toBe("growth");
    expect(config.fallbackModel).toBe("claude-haiku-4-5");
    expect(config.secretDenylist).toEqual(["tok1", "tok2"]);
    expect(config.harnessExtraArgs).toEqual(["--flag", "value"]);
  });

  it("names the missing variable", () => {
    const missing: Record<string, string | undefined> = { ...complete };
    delete missing.OPERON_MIND_CREDENTIAL;
    expect(() => readWakeConfig(missing)).toThrowError(ConfigError);
    expect(() => readWakeConfig(missing)).toThrowError(/OPERON_MIND_CREDENTIAL/);
  });

  it("defaults denylist and extra args to empty", () => {
    const config = readWakeConfig(complete);
    expect(config.secretDenylist).toEqual([]);
    expect(config.harnessExtraArgs).toEqual([]);
  });

  it("reads the egress blocklist and rejects a malformed one", () => {
    expect(readWakeConfig(complete).egressBlocklist).toEqual([]);
    expect(
      readWakeConfig({ ...complete, OPERON_EGRESS_BLOCKLIST: '["Tracker.Example", "*.ads.example"]' }).egressBlocklist
    ).toEqual(["tracker.example", "*.ads.example"]);
    expect(() => readWakeConfig({ ...complete, OPERON_EGRESS_BLOCKLIST: '["bad host"]' })).toThrowError(
      /OPERON_EGRESS_BLOCKLIST/
    );
    expect(() => readWakeConfig({ ...complete, OPERON_EGRESS_BLOCKLIST: "tracker.example" })).toThrowError(ConfigError);
  });

  it("reads the outbound proxy table, defaults it to all-direct, and rejects a malformed one", () => {
    expect(readWakeConfig(complete).egressProxy).toEqual({ rules: [{ pattern: "*", target: "direct" }] });
    const table = JSON.stringify({
      proxies: { a: "http://a.example:7777", b: "http://user:secret@b.example:8888" },
      routes: { "*": "a", "docs.example": "b", "*.reg.example": "direct" }
    });
    expect(readWakeConfig({ ...complete, OPERON_EGRESS_PROXY: table }).egressProxy).toEqual({
      rules: [
        { pattern: "*", target: { name: "a", tls: false, hostname: "a.example", port: 7777 } },
        {
          pattern: "docs.example",
          target: {
            name: "b",
            tls: false,
            hostname: "b.example",
            port: 8888,
            authorization: `Basic ${Buffer.from("user:secret").toString("base64")}`
          }
        },
        { pattern: "*.reg.example", target: "direct" }
      ]
    });
    // A bare address is not a policy.
    expect(() =>
      readWakeConfig({ ...complete, OPERON_EGRESS_PROXY: "http://proxy.example:7777" })
    ).toThrowError(/OPERON_EGRESS_PROXY/);
    expect(() =>
      readWakeConfig({ ...complete, OPERON_EGRESS_PROXY: '{"routes": {"*": "nowhere"}}' })
    ).toThrowError(ConfigError);
  });

  it("defaults maxWakeMinutes to 120 and rejects malformed values", () => {
    expect(readWakeConfig(complete).maxWakeMinutes).toBe(120);
    expect(
      readWakeConfig({ ...complete, OPERON_MAX_WAKE_MINUTES: "90" }).maxWakeMinutes
    ).toBe(90);
    expect(() =>
      readWakeConfig({ ...complete, OPERON_MAX_WAKE_MINUTES: "soon" })
    ).toThrowError(/OPERON_MAX_WAKE_MINUTES/);
  });

  it("rejects malformed extra args loudly instead of splitting on spaces", () => {
    expect(() =>
      readWakeConfig({ ...complete, OPERON_HARNESS_EXTRA_ARGS: "--not-json" })
    ).toThrowError(/OPERON_HARNESS_EXTRA_ARGS/);
  });
});
