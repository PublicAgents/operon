import { describe, expect, it } from "vitest";
import { parseManifest, validateManifest, ManifestError } from "./manifest.js";

const BASE = {
  project: "demo",
  accountId: "85c7962b4a17a841ef0689e0e7c2a050",
  access: {
    teamDomain: "https://example.cloudflareaccess.com",
    aud: "885307dbdffd16d85609cecf4cb88f6119ce65a041540315ae9ad26b13d69025"
  },
  zone: "demo-colony.com",
  agents: [
    {
      id: "scout",
      stateRepo: "demo/scout-state",
      cadence: "0 6 * * *",
      harness: "claude-code",
      model: "claude-fable-5",
      maxWakeMinutes: 30,
      hosts: ["@"],
      enabled: true
    }
  ]
};

describe("validateManifest", () => {
  it("accepts a minimal manifest and fills chassis defaults", () => {
    const manifest = validateManifest(BASE);
    expect(manifest.project).toBe("demo");
    expect(manifest.workerPrefix).toBe("operon-demo");
    expect(manifest.resources.d1Name).toBe("operon-demo");
    expect(manifest.containers.maxInstances).toBe(4);
    expect(manifest.roster.agents[0].id).toBe("scout");
  });

  it("the directory name and the project field are one identity", () => {
    expect(() => validateManifest(BASE, { directoryName: "other" })).toThrow(ManifestError);
    expect(validateManifest(BASE, { directoryName: "demo" }).project).toBe("demo");
  });

  it("refuses unknown policy workers and unknown policy vars (typos never pass silently)", () => {
    expect(() => validateManifest({ ...BASE, policy: { spender: {} } })).toThrow(/not a policy-bearing/);
    expect(() => validateManifest({ ...BASE, policy: { spend: { SPEND_MAX_TXX: "1" } } })).toThrow(
      /not a known var/
    );
    expect(() => validateManifest({ ...BASE, policy: { spend: { SPEND_MAX_TX: 1 } } })).toThrow(
      /must be a string/
    );
  });

  it("delegates roster validation to the chassis parser", () => {
    expect(() =>
      validateManifest({ ...BASE, agents: [{ ...BASE.agents[0] }, { ...BASE.agents[0] }] })
    ).toThrow(/duplicate agent id/);
  });

  it("validates identity fields precisely", () => {
    expect(() => validateManifest({ ...BASE, project: "Demo" })).toThrow(ManifestError);
    expect(() => validateManifest({ ...BASE, accountId: "nope" })).toThrow(/32-hex/);
    expect(() => validateManifest({ ...BASE, access: { ...BASE.access, aud: "short" } })).toThrow(/64-hex/);
  });

  it("parses YAML end to end", () => {
    const yaml = [
      "project: demo",
      `accountId: "${BASE.accountId}"`,
      "access:",
      `  teamDomain: ${BASE.access.teamDomain}`,
      `  aud: "${BASE.access.aud}"`,
      "zone: demo-colony.com",
      "agents:",
      "  - id: scout",
      "    stateRepo: demo/scout-state",
      '    cadence: "0 6 * * *"',
      "    harness: claude-code",
      "    model: claude-fable-5",
      "    maxWakeMinutes: 30",
      '    hosts: ["@"]',
      "    enabled: true"
    ].join("\n");
    expect(parseManifest(yaml).workerPrefix).toBe("operon-demo");
  });
});
