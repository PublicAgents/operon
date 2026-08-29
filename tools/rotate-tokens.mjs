#!/usr/bin/env node
/**
 * Rotate every INTERNAL bearer of the colony in one command:
 *
 *   npm run rotate:tokens              # all internal bearers (from the colony root)
 *   npm run rotate:tokens -- --only notify,wake-trigger
 *   npm run rotate:tokens -- --direct  # skip the gateway, write via wrangler
 *
 * Internal bearers are the tokens both sides of which live in OUR
 * Workers, so rotation is self-contained: one fresh value per group,
 * applied to every worker in the group. External credentials (mind
 * credential, Telegram bot token, machine PATs, MPP/Tempo keys,
 * SECRET_DENYLIST) are deliberately NOT touched here.
 *
 * The PREFERRED path is the ops gateway's secret_rotate_group tool
 * (spec 0005 §6): rotations there are serialized per group through a
 * Durable Object and keep durable resume state, so a CLI rotation can
 * never interleave with a console/MCP rotation of the same group. The
 * direct wrangler path remains for gateways without CLOUDFLARE_API_TOKEN
 * (and --direct); it writes values over stdin (never argv, never
 * printed) but is NOT serialized against the gateway: do not run it
 * while a console rotation might be in flight.
 *
 * There is a seconds-wide window while a group's puts land in sequence
 * where a call between two members 401s once; rotate while agents are
 * disabled or idle. Secrets survive deploys, so this needs no redeploy.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { groupsFor } from "./rotate-groups.mjs";

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
const GROUPS = groupsFor(roster);

const onlyArg = process.argv.indexOf("--only");
const direct = process.argv.includes("--direct");
const selected =
  onlyArg !== -1 && process.argv[onlyArg + 1]
    ? process.argv[onlyArg + 1].split(",").map(name => name.trim())
    : Object.keys(GROUPS);
const unknown = selected.filter(name => !GROUPS[name]);
if (unknown.length > 0) {
  console.error(`unknown group(s): ${unknown.join(", ")}\nknown: ${Object.keys(GROUPS).join(", ")}`);
  process.exit(2);
}

/** The ops gateway URL, exactly as tail-wake discovers it. */
function opsUrl() {
  if (process.env.OPERON_OPS_URL) return process.env.OPERON_OPS_URL;
  const configPath = join(ROOT, "workers", "gatekeeper-ops", "wrangler.jsonc");
  if (!existsSync(configPath)) return undefined;
  const pattern = JSON.parse(stripJsonc(readFileSync(configPath, "utf8"))).routes?.[0]?.pattern;
  return pattern ? `https://${pattern}` : undefined;
}

/**
 * Rotate through the gateway (serialized, durable resume). Returns true
 * when the gateway handled it; false means fall back to direct writes.
 */
async function rotateViaGateway(groups) {
  const ops = opsUrl();
  if (!ops) return false;
  let token;
  try {
    token = execFileSync("cloudflared", ["access", "token", "--app", ops], {
      encoding: "utf8"
    }).trim();
  } catch {
    console.log(`no Access session for ${ops}; falling back to direct wrangler writes`);
    return false;
  }
  for (const name of groups) {
    const response = await fetch(`${ops}/api/v1/secret-rotate-group`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
      body: JSON.stringify({ group: name })
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 503) {
      // The gateway has no CLOUDFLARE_API_TOKEN: nothing there can race
      // us, so the direct path is safe for the whole run.
      console.log("gateway secrets tools unconfigured; falling back to direct wrangler writes");
      return false;
    }
    if (!response.ok) {
      console.error(`✗ ${name}: gateway answered ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`→ rotated "${name}" via the gateway (${(body.written ?? []).length} member(s))`);
  }
  return true;
}

function putDirect(workerDir, secretName, value) {
  execFileSync(
    "npx",
    ["wrangler", "secret", "put", secretName, "-c", `workers/${workerDir}/wrangler.jsonc`],
    { cwd: ROOT, input: value, stdio: ["pipe", "inherit", "inherit"] }
  );
}

if (!direct && (await rotateViaGateway(selected))) {
  console.log(`\n✓ rotated: ${selected.join(", ")} (values never printed; secrets survive deploys)`);
  process.exit(0);
}

for (const name of selected) {
  const value = randomBytes(32).toString("hex");
  console.log(`\n→ rotating "${name}" across ${GROUPS[name].length} worker(s) (direct)`);
  for (const [workerDir, secretName] of GROUPS[name]) {
    console.log(`  ${workerDir} · ${secretName}`);
    putDirect(workerDir, secretName, value);
  }
}

console.log(`\n✓ rotated: ${selected.join(", ")} (values never printed; secrets survive deploys)`);
