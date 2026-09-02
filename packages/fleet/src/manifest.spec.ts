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

describe("capability grants through the manifest (spec 0008)", () => {
  const withGrants = () => ({
    ...structuredClone(BASE),
    mcp: {
      "google-analytics": { type: "gatekeeper", worker: "gatekeeper-google-analytics" }
    },
    agents: [
      {
        ...structuredClone(BASE.agents[0]),
        mcp: ["google-analytics"],
        github: { pr: ["demo/product"] }
      }
    ]
  });

  it("carries mcp defs into the roster, and they survive the deployed ROSTER var shape", () => {
    const manifest = validateManifest(withGrants());
    expect(manifest.roster.mcp?.["google-analytics"]).toEqual({
      type: "gatekeeper",
      worker: "gatekeeper-google-analytics"
    });
    // What fleet.mjs actually deploys: the round trip must preserve
    // the defs, or a grant validates at check and vanishes in prod.
    const rosterVar = JSON.stringify({
      zone: manifest.roster.zone,
      agents: manifest.roster.agents,
      ...(manifest.roster.mcp !== undefined ? { mcp: manifest.roster.mcp } : {})
    });
    const redeployed = validateManifest({
      ...withGrants(),
      ...JSON.parse(rosterVar)
    });
    expect(redeployed.roster.mcp).toEqual(manifest.roster.mcp);
    expect(redeployed.roster.agents[0].mcp).toEqual(["google-analytics"]);
  });

  it("refuses PR_REPOS alongside a per-agent github.pr grant", () => {
    const conflicted = {
      ...withGrants(),
      policy: { pr: { PR_REPOS: "demo/product" } }
    };
    expect(() => validateManifest(conflicted)).toThrow(/conflicts with agents.scout.github.pr/);
  });

  it("keeps PR_REPOS working for agents without a github block", () => {
    const legacy = {
      ...structuredClone(BASE),
      policy: { pr: { PR_REPOS: "demo/product" } }
    };
    expect(validateManifest(legacy).policy.pr?.PR_REPOS).toBe("demo/product");
  });

  it("roster refusals surface through the manifest (one validator)", () => {
    const bad = withGrants();
    (bad.agents[0].mcp as string[]).push("ghost");
    expect(() => validateManifest(bad)).toThrow(/names no server/);
  });
});

describe("the control plane's enrollment (spec 0006 §9)", () => {
  it("defaults to this project alone", () => {
    const manifest = validateManifest(BASE);
    expect(manifest.control).toEqual({ defaultProject: "demo", enrolled: [] });
  });

  it("enrolls other projects with their zone and a derived prefix, and accepts one as default", () => {
    const manifest = validateManifest({
      ...BASE,
      control: { default: "second-one", projects: [{ project: "second-one", zone: "second.example" }] }
    });
    expect(manifest.control).toEqual({
      defaultProject: "second-one",
      enrolled: [{ project: "second-one", zone: "second.example", workerPrefix: "operon-second-one" }]
    });
  });

  it("refuses enrollment mistakes by name: the host itself, duplicates, a default that is nobody, unknown keys", () => {
    expect(() =>
      validateManifest({ ...BASE, control: { projects: [{ project: "demo", zone: "z.example" }] } })
    ).toThrow(/enrolled implicitly/);
    expect(() =>
      validateManifest({
        ...BASE,
        control: {
          projects: [
            { project: "second-one", zone: "a.example" },
            { project: "second-one", zone: "b.example" }
          ]
        }
      })
    ).toThrow(/listed twice/);
    expect(() => validateManifest({ ...BASE, control: { default: "nobody" } })).toThrow(/neither this project/);
    expect(() =>
      validateManifest({ ...BASE, control: { projects: [{ project: "second-one", zone: "z.example", extra: 1 }] } })
    ).toThrow(/not a known key/);
    expect(() => validateManifest({ ...BASE, control: { projects: [{ project: "second-one" }] } })).toThrow(/zone/);
    expect(() =>
      validateManifest({
        ...BASE,
        control: {
          projects: [
            { project: "second-one", zone: "a.example", workerPrefix: "shared-prefix" },
            { project: "third-one", zone: "b.example", workerPrefix: "shared-prefix" }
          ]
        }
      })
    ).toThrow(/already the prefix of another enrolled project/);
    expect(() =>
      validateManifest({
        ...BASE,
        control: { projects: [{ project: "second-one", zone: "a.example", workerPrefix: "operon-demo" }] }
      })
    ).toThrow(/this project's own prefix/);
  });
});
