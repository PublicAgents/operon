import { describe, expect, it } from "vitest";
import { validateManifest } from "./manifest.js";
import { requiredSecrets, secretsByWorker } from "./secrets.js";

const BASE = {
  project: "demo",
  accountId: "0123456789abcdef0123456789abcdef",
  access: {
    teamDomain: "https://demo.cloudflareaccess.com",
    aud: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
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
    const grok = requiredSecrets(
      validateManifest({ ...BASE, agents: [{ ...BASE.agents[0], harness: "grok" }] })
    ).map(r => `${r.worker}/${r.name}`);
    expect(grok).toContain("scheduler/MIND_CREDENTIAL_GROK");
    expect(grok).not.toContain("scheduler/MIND_CREDENTIAL_CLAUDE_CODE");
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
        proxies: {
          general: { address: "http://general.proxy.example:7777", credential: "PROXY_GENERAL" },
          docs: { address: "http://other.proxy.example:8888", credential: "PROXY_DOCS" }
        },
        proxy: { "*": "general", "docs.example": "docs", "*.registry.example": "direct" }
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

  it("requires the provider's signing secret for a server that takes callbacks (spec 0014 §3)", () => {
    const manifest = validateManifest({
      ...BASE,
      mcp: {
        tasks: {
          type: "http",
          url: "https://tasks.example/mcp",
          auth: "bearer",
          tools: ["createDeepResearch"],
          webhook: {
          createTools: ["createDeepResearch"],
          argument: "webhook",
          registration: { url: "{url}", event_types: "{events}" },
          events: ["task_run.status"],
          runIdPath: "run_id",
          callbackRunIdPath: "data.run_id",
          callbackEventPath: "type",
          signature: { header: "X-Signature", scheme: "hmac-sha256-hex" }
        }
        },
        plain: { type: "http", url: "https://mcp.example.com/mcp", auth: "none" }
      },
      agents: [{ ...BASE.agents[0], mcp: ["tasks", "plain"] }]
    });
    const names = requiredSecrets(manifest).map(r => `${r.worker}/${r.name}`);
    expect(names).toContain("gatekeeper-mcp/MCP_TASKS_TOKEN");
    expect(names).toContain("gatekeeper-mcp/MCP_TASKS_WEBHOOK_SECRET");
    expect(names).not.toContain("gatekeeper-mcp/MCP_PLAIN_WEBHOOK_SECRET");
  });

  it("groups by worker with required names first", () => {
    const grouped = secretsByWorker(requiredSecrets(validateManifest(BASE)));
    const telegram = grouped.get("gatekeeper-telegram") ?? [];
    expect(telegram[0].optional).toBeUndefined();
    expect(telegram[telegram.length - 1].optional).toBe(true);
  });
});
