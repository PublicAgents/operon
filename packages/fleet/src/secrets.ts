import { rotationGroups } from "@operon/ops-tools";
import { egressCredentialSecret, egressPolicyCredentials } from "@operon/core";
import type { FleetManifest } from "./manifest.js";

/**
 * Every secret a project's Workers need, declared from the manifest
 * (spec 0006 §2: "declared secrets are part of the schema"). Bootstrap
 * and `deploy --check` compare this against what the Workers hold, by
 * NAME only (labels ledgered, values never), and report the gap as a
 * checklist the operator sets out of band.
 *
 * Three sources, one list:
 * - the internal bearer groups (both ends in our Workers; minted by the
 *   rotation tools), per worker directory;
 * - the per-agent bearers, from the roster;
 * - the external credentials the operator obtains elsewhere (the mind
 *   credential, the GitHub App key, machine PATs, provider keys), some
 *   optional: a colony runs without Telegram, without X, without a
 *   Cloudflare API token on the gateway, at reduced capability.
 */

export interface SecretRequirement {
  /** Worker directory, as the templates key them: scheduler, gatekeeper-x, ... */
  worker: string;
  name: string;
  /** What it is, for the checklist. */
  purpose: string;
  /** Optional secrets leave a capability off rather than the project broken. */
  optional?: boolean;
}

function agentVar(agentId: string): string {
  return agentId.toUpperCase().replace(/-/g, "_");
}

export function requiredSecrets(manifest: FleetManifest): SecretRequirement[] {
  const agents = manifest.roster.agents.map(agent => agent.id);
  const out: SecretRequirement[] = [];
  const seen = new Set<string>();
  const add = (requirement: SecretRequirement) => {
    const key = `${requirement.worker}/${requirement.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(requirement);
  };

  // Internal bearers: one value per group, on every member.
  for (const [group, pairs] of Object.entries(rotationGroups(agents))) {
    for (const [worker, name] of pairs) {
      add({ worker, name, purpose: `internal bearer, group "${group}" (npm run rotate:tokens -- --only ${group})` });
    }
  }

  // The mind and the fences. One credential per HARNESS in the roster,
  // under the name the scheduler's launch reads (MIND_CREDENTIAL_<HARNESS>).
  for (const harness of new Set(manifest.roster.agents.map(agent => agent.harness))) {
    add({
      worker: "scheduler",
      name: `MIND_CREDENTIAL_${agentVar(harness)}`,
      purpose:
        harness === "claude-code"
          ? "the dedicated Claude account's setup-token"
          : `the credential the "${harness}" harness signs in with`
    });
  }
  add({ worker: "scheduler", name: "SECRET_DENYLIST", purpose: "literals kept off published surfaces (itself secret)" });
  add({ worker: "gatekeeper-deploy", name: "SECRET_DENYLIST", purpose: "same value as the scheduler's" });

  // GitHub: the App (content writes) and the machine accounts (PRs).
  add({ worker: "gatekeeper-github", name: "GITHUB_APP_ID", purpose: "the GitHub App's id" });
  add({ worker: "gatekeeper-github", name: "GITHUB_APP_PRIVATE_KEY", purpose: "the App's private key, PKCS8 PEM" });
  add({ worker: "gatekeeper-github", name: "GITHUB_INSTALLATION_ID", purpose: "the App's installation id on the org" });
  for (const agentId of agents) {
    add({
      worker: "gatekeeper-pr",
      name: `MACHINE_PAT_${agentVar(agentId)}`,
      purpose: `the PAT of ${agentId}'s own machine account (<agent>-<project>-bot); MACHINE_PAT is the shared fallback`
    });
  }

  // Optional capabilities: absent, the door stays closed or degraded by name.
  add({ worker: "gatekeeper-telegram", name: "TELEGRAM_BOT_TOKEN", purpose: "the bot from BotFather (without it, notifies land in the console only)", optional: true });
  add({ worker: "gatekeeper-telegram", name: "TELEGRAM_WEBHOOK_SECRET", purpose: "openssl rand -hex 32", optional: true });
  add({ worker: "gatekeeper-telegram", name: "OPERATOR_CHAT_ID", purpose: "your Telegram chat id", optional: true });
  add({ worker: "gatekeeper-ops", name: "CLOUDFLARE_API_TOKEN", purpose: "Workers Scripts:Edit, enables the console's secrets tools", optional: true });
  add({ worker: "gatekeeper-x", name: "X_API_KEY", purpose: "the X developer app's key", optional: true });
  add({ worker: "gatekeeper-x", name: "X_API_SECRET", purpose: "the X developer app's secret", optional: true });
  for (const agentId of agents) {
    add({ worker: "gatekeeper-x", name: `X_ACCESS_TOKEN_${agentVar(agentId)}`, purpose: `${agentId}'s X account token (node operon/tools/x-authorize.mjs ${agentId})`, optional: true });
    add({ worker: "gatekeeper-x", name: `X_ACCESS_SECRET_${agentVar(agentId)}`, purpose: `${agentId}'s X account secret (same tool)`, optional: true });
  }
  add({ worker: "gatekeeper-spend", name: "MPP_PRIVATE_KEY", purpose: "the spend wallet's key", optional: true });
  add({ worker: "gatekeeper-spend", name: "TEMPO_API_KEY", purpose: "the Tempo API key (spend)", optional: true });
  add({ worker: "gatekeeper-till", name: "MPP_SECRET_KEY", purpose: "the till's MPP key", optional: true });
  add({ worker: "gatekeeper-till", name: "TEMPO_API_KEY", purpose: "the Tempo API key (till)", optional: true });
  add({ worker: "gatekeeper-browser", name: "BROWSER_RUN_TOKEN", purpose: "the Browser Run token", optional: true });
  // The outbound proxies (spec 0004 §8) name their credentials; each
  // one is a scheduler secret holding user:pass.
  if (manifest.egress?.proxies !== undefined) {
    for (const name of egressPolicyCredentials({ proxies: manifest.egress.proxies, routes: {} })) {
      const owners = Object.entries(manifest.egress.proxies)
        .filter(([, proxy]) => proxy.credential === name)
        .map(([proxyName]) => proxyName);
      add({
        worker: "scheduler",
        name: egressCredentialSecret(name),
        purpose: `user:pass for the outbound proxy ${owners.map(o => `"${o}"`).join(", ")} (spec 0004 §8)`
      });
    }
  }

  // Capability grants (spec 0008): what the manifest declares, it needs.
  const mcp = manifest.roster.mcp ?? {};
  for (const [name, def] of Object.entries(mcp)) {
    if (def.type === "gatekeeper" && def.worker === "gatekeeper-google-analytics") {
      add({ worker: "gatekeeper-google-analytics", name: "GA_SERVICE_ACCOUNT", purpose: "the GA service account's JSON key" });
    }
    if (def.type === "http" && def.auth === "bearer") {
      add({ worker: "gatekeeper-mcp", name: `MCP_${agentVar(name)}_TOKEN`, purpose: `the bearer for the "${name}" MCP server` });
    }
    if (def.type === "portal") {
      add({ worker: "gatekeeper-mcp", name: "MCP_PORTAL_CLIENT_ID", purpose: "the Access service token id for the MCP portal" });
      add({ worker: "gatekeeper-mcp", name: "MCP_PORTAL_CLIENT_SECRET", purpose: "the Access service token secret for the MCP portal" });
    }
  }

  // The control plane's bearers for enrolled projects (spec 0006 §9).
  for (const enrolled of manifest.control.enrolled) {
    add({
      worker: "gatekeeper-ops",
      name: `WAKE_TRIGGER_TOKEN_${agentVar(enrolled.project)}`,
      purpose: `the wake-trigger bearer of the enrolled project "${enrolled.project}" (its scheduler's WAKE_TRIGGER_TOKEN)`
    });
  }

  return out;
}

/** The requirements grouped by worker, required first, for a checklist. */
export function secretsByWorker(requirements: SecretRequirement[]): Map<string, SecretRequirement[]> {
  const grouped = new Map<string, SecretRequirement[]>();
  for (const requirement of requirements) {
    const list = grouped.get(requirement.worker) ?? [];
    list.push(requirement);
    grouped.set(requirement.worker, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => Number(a.optional ?? false) - Number(b.optional ?? false) || a.name.localeCompare(b.name));
  }
  return grouped;
}
