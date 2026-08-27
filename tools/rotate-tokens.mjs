#!/usr/bin/env node
/**
 * Rotate every INTERNAL bearer of the colony in one command:
 *
 *   npm run rotate:tokens              # all internal bearers (from the colony root)
 *   npm run rotate:tokens -- --only notify,operator
 *
 * Internal bearers are the tokens both sides of which live in OUR
 * Workers (or the operator's own file), so rotation is self-contained:
 * one fresh value per group, put onto every worker in the group over
 * stdin (never argv, never printed). External credentials (mind
 * credential, Telegram bot token, machine PATs, MPP/Tempo keys,
 * SECRET_DENYLIST) are deliberately NOT touched here.
 *
 * There is a seconds-wide window while a group's puts land in sequence
 * where a call between two members 401s once; rotate while agents are
 * disabled or idle. Secrets survive deploys, so this needs no redeploy.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Chassis tooling, colony data: run from a COLONY checkout's root (the
// repo holding roster.jsonc and workers/*/wrangler.jsonc). The chassis
// ships the tool; the deployment supplies everything it touches.
const ROOT = process.cwd();
if (!existsSync(join(ROOT, "roster.jsonc"))) {
  console.error("run this from a colony root (no roster.jsonc here)");
  process.exit(2);
}

function stripJsonc(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const roster = JSON.parse(stripJsonc(readFileSync(join(ROOT, "roster.jsonc"), "utf8")));
const agentVar = agentId => agentId.toUpperCase().replace(/-/g, "_");

/** name -> [workerDir, secretName][]; every group shares ONE fresh value. */
const GROUPS = {
  // telegram accepts; scheduler and the notifying gatekeepers present.
  notify: [
    ["gatekeeper-telegram", "NOTIFY_TOKEN"],
    ["scheduler", "NOTIFY_TOKEN"],
    ["gatekeeper-email", "NOTIFY_TOKEN"],
    ["gatekeeper-spend", "NOTIFY_TOKEN"],
    ["gatekeeper-vault", "NOTIFY_TOKEN"]
  ],
  // Every ledger/read surface; the operator's own copy is refreshed too.
  operator: [
    ["gatekeeper-telegram", "OPERATOR_API_TOKEN"],
    ["gatekeeper-email", "OPERATOR_API_TOKEN"],
    ["gatekeeper-spend", "OPERATOR_API_TOKEN"],
    ["gatekeeper-till", "OPERATOR_API_TOKEN"],
    ["gatekeeper-github", "OPERATOR_API_TOKEN"],
    ["gatekeeper-pr", "OPERATOR_API_TOKEN"],
    ["gatekeeper-deploy", "OPERATOR_API_TOKEN"],
    ["gatekeeper-vault", "OPERATOR_API_TOKEN"],
    ["gatekeeper-chronicle", "OPERATOR_API_TOKEN"]
  ],
  publish: [
    ["gatekeeper-deploy", "PUBLISH_TOKEN"],
    ["scheduler", "PUBLISH_TOKEN"]
  ],
  "github-token-mint": [
    ["gatekeeper-github", "TOKEN_SERVICE_TOKEN"],
    ["scheduler", "GITHUB_TOKEN_SERVICE_TOKEN"]
  ],
  persist: [
    ["gatekeeper-github", "COMMIT_SERVICE_TOKEN"],
    ["scheduler", "PERSIST_TOKEN"]
  ],
  pr: [
    ["gatekeeper-pr", "PR_SERVICE_TOKEN"],
    ["scheduler", "PR_TOKEN"]
  ],
  email: [
    ["gatekeeper-email", "EMAIL_SERVICE_TOKEN"],
    ["scheduler", "EMAIL_TOKEN"]
  ],
  "wake-trigger": [
    ["scheduler", "WAKE_TRIGGER_TOKEN"],
    ["gatekeeper-telegram", "WAKE_TRIGGER_TOKEN"]
  ],
  chronicle: [
    ["gatekeeper-chronicle", "CHRONICLE_SERVICE_TOKEN"],
    ["scheduler", "CHRONICLE_TOKEN"]
  ]
};

// Per-agent money and vault bearers, from the roster (spec 0002 §3).
for (const agent of roster.agents) {
  const suffix = agentVar(agent.id);
  GROUPS[`till-${agent.id}`] = [
    ["gatekeeper-till", `TILL_TOKEN_${suffix}`],
    ["scheduler", `TILL_TOKEN_${suffix}`]
  ];
  GROUPS[`spend-${agent.id}`] = [
    ["gatekeeper-spend", `SPEND_TOKEN_${suffix}`],
    ["scheduler", `SPEND_TOKEN_${suffix}`]
  ];
  GROUPS[`vault-${agent.id}`] = [
    ["gatekeeper-vault", `VAULT_TOKEN_${suffix}`],
    ["scheduler", `VAULT_TOKEN_${suffix}`]
  ];
  GROUPS[`x-${agent.id}`] = [
    ["gatekeeper-x", `X_TOKEN_${suffix}`],
    ["scheduler", `X_TOKEN_${suffix}`]
  ];
}

const onlyArg = process.argv.indexOf("--only");
const selected =
  onlyArg !== -1 && process.argv[onlyArg + 1]
    ? process.argv[onlyArg + 1].split(",").map(name => name.trim())
    : Object.keys(GROUPS);
const unknown = selected.filter(name => !GROUPS[name]);
if (unknown.length > 0) {
  console.error(`unknown group(s): ${unknown.join(", ")}\nknown: ${Object.keys(GROUPS).join(", ")}`);
  process.exit(2);
}

function put(workerDir, secretName, value) {
  execFileSync(
    "npx",
    ["wrangler", "secret", "put", secretName, "-c", `workers/${workerDir}/wrangler.jsonc`],
    { cwd: ROOT, input: value, stdio: ["pipe", "inherit", "inherit"] }
  );
}

for (const name of selected) {
  const value = randomBytes(32).toString("hex");
  console.log(`\n→ rotating "${name}" across ${GROUPS[name].length} worker(s)`);
  for (const [workerDir, secretName] of GROUPS[name]) {
    console.log(`  ${workerDir} · ${secretName}`);
    put(workerDir, secretName, value);
  }
  if (name === "operator") {
    const file = join(homedir(), ".operon-operator-api-token");
    writeFileSync(file, `${value}\n`);
    chmodSync(file, 0o600);
    console.log(`  operator copy refreshed at ${file}`);
  }
}

console.log(`\n✓ rotated: ${selected.join(", ")} (values never printed; secrets survive deploys)`);
