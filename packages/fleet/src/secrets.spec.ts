import { describe, expect, it } from "vitest";
import { validateManifest } from "./manifest.js";
import { requiredSecrets, secretsByWorker } from "./secrets.js";

const BASE = {
  project: "demo",
  accountId: "85c7962b4a17a841ef0689e0e7c2a050",
  access: {
    teamDomain: "https://demo.cloudflareaccess.com",
    aud: "885307dbdffd16d85609cecf4cb88f6119ce65a041540315ae9ad26b13d69025"
  },
  zone: "demo.example",
  agents: [
    {
      id: "promoter",
      stateRepo: "demo/promoter-state",
      cadence: "0 6 * * *",
      harness: "claude-code",
      model: "claude-fable-5",
      hosts: ["@"],
      enabled: true
    }
  ]
};

describe("requiredSecrets", () => {
  it("names the internal bearers on both ends, the per-agent bearers, and the externals", () => {
    const names = requiredSecrets(validateManifest(BASE)).map(r => `${r.worker}/${r.name}`);
    expect(names).toContain("scheduler/WAKE_TRIGGER_TOKEN");
    expect(names).toContain("gatekeeper-ops/WAKE_TRIGGER_TOKEN");
    expect(names).toContain("gatekeeper-asks/ASKS_TOKEN_PROMOTER");
    expect(names).toContain("scheduler/ASKS_TOKEN_PROMOTER");
    expect(names).toContain("scheduler/MIND_CREDENTIAL_CLAUDE_CODE");
    const codex = requiredSecrets(
      validateManifest({ ...BASE, agents: [{ ...BASE.agents[0], harness: "codex" }] })
    ).map(r => `${r.worker}/${r.name}`);
    expect(codex).toContain("scheduler/MIND_CREDENTIAL_CODEX");
    expect(codex).not.toContain("scheduler/MIND_CREDENTIAL_CLAUDE_CODE");
    expect(names).toContain("gatekeeper-github/GITHUB_APP_PRIVATE_KEY");
    expect(names).toContain("gatekeeper-pr/MACHINE_PAT_PROMOTER");
    // No duplicates: a worker/name pair appears once however many sources name it.
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks the capabilities a colony can run without as optional", () => {
    const byKey = Object.fromEntries(requiredSecrets(validateManifest(BASE)).map(r => [`${r.worker}/${r.name}`, r]));
    expect(byKey["gatekeeper-telegram/TELEGRAM_BOT_TOKEN"].optional).toBe(true);
    expect(byKey["gatekeeper-x/X_ACCESS_TOKEN_PROMOTER"].optional).toBe(true);
    expect(byKey["scheduler/WAKE_TRIGGER_TOKEN"].optional).toBeUndefined();
  });

  it("derives the outbound proxy credentials from the table's placeholders", () => {
    const withProxy = validateManifest({
      ...BASE,
      egress: {
        "*": "http://${PROXY_GENERAL}@general.proxy.example:7777",
        "docs.example": "http://${PROXY_DOCS}@other.proxy.example:8888",
        "*.registry.example": "direct"
      }
    });
    const names = requiredSecrets(withProxy).map(r => `${r.worker}/${r.name}`);
    expect(names).toContain("scheduler/EGRESS_CREDENTIAL_PROXY_GENERAL");
    expect(names).toContain("scheduler/EGRESS_CREDENTIAL_PROXY_DOCS");
    expect(names.filter(n => n.startsWith("scheduler/EGRESS_CREDENTIAL_"))).toHaveLength(2);
    // No table, no proxy secrets.
    const without = requiredSecrets(validateManifest(BASE)).map(r => `${r.worker}/${r.name}`);
    expect(without.some(n => n.startsWith("scheduler/EGRESS_CREDENTIAL_"))).toBe(false);
  });

  it("requires what the manifest's grants declare", () => {
    const manifest = validateManifest({
      ...BASE,
      mcp: {
        "google-analytics": { type: "gatekeeper", worker: "gatekeeper-google-analytics" },
        linear: { type: "http", url: "https://mcp.linear.app/mcp", auth: "bearer" },
        open: { type: "http", url: "https://mcp.example.com/mcp", auth: "none" }
      },
      agents: [{ ...BASE.agents[0], mcp: ["google-analytics", "linear", "open"] }],
      control: { projects: [{ project: "second-one", zone: "second.example" }] }
    });
    const names = requiredSecrets(manifest).map(r => `${r.worker}/${r.name}`);
    expect(names).toContain("gatekeeper-google-analytics/GA_SERVICE_ACCOUNT");
    expect(names).toContain("gatekeeper-mcp/MCP_LINEAR_TOKEN");
    expect(names).not.toContain("gatekeeper-mcp/MCP_OPEN_TOKEN");
    expect(names).toContain("gatekeeper-ops/WAKE_TRIGGER_TOKEN_SECOND_ONE");
  });

  it("groups by worker with required names first", () => {
    const grouped = secretsByWorker(requiredSecrets(validateManifest(BASE)));
    const telegram = grouped.get("gatekeeper-telegram") ?? [];
    expect(telegram[0].optional).toBeUndefined();
    expect(telegram[telegram.length - 1].optional).toBe(true);
  });
});
