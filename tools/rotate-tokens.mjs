#!/usr/bin/env node
/**
 * Rotate every INTERNAL bearer of the colony in one command:
 *
 *   npm run rotate:tokens              # all internal bearers (from the project root)
 *   npm run rotate:tokens -- --only notify,wake-trigger
 *   npm run rotate:tokens -- --direct  # skip the gateway, write via wrangler
 *   npm run rotate:tokens -- --project <name>   # when the repo holds several
 *
 * Internal bearers are the tokens both sides of which live in OUR
 * Workers, so rotation is self-contained: one fresh value per group,
 * applied to every worker in the group. External credentials (mind
 * credential, Telegram bot token, machine PATs, MPP/Tempo keys,
 * SECRET_DENYLIST) are deliberately NOT touched here.
 *
 * The NORMAL path is the ops gateway's secret_rotate_group tool
 * (spec 0005 §6): rotations there are serialized per group through a
 * Durable Object and keep durable resume state, so a CLI rotation can
 * never interleave with a console/MCP rotation of the same group.
 * Direct wrangler writes (values over stdin, never argv, never
 * printed) happen automatically ONLY when they provably cannot race a
 * gateway rotation: the colony has no gateway config, or the gateway's
 * secrets tools are unconfigured. Every other gateway failure aborts;
 * --direct overrides for the operator who knows nothing is in flight.
 *
 * There is a seconds-wide window while a group's puts land in sequence
 * where a call between two members 401s once; rotate while agents are
 * disabled or idle. Secrets survive deploys, so this needs no redeploy.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rotationGroups } from "../packages/ops-tools/dist/rotation.js";
import { loadProject } from "./colony.mjs";

// Chassis tooling, project data: run from a PROJECT checkout's root
// (the repo holding .operon/operon.yaml). The chassis ships the tool;
// the deployment supplies everything it touches.
const ROOT = process.cwd();
const projectFlag = process.argv.indexOf("--project");
let project;
try {
  project = await loadProject(ROOT, projectFlag !== -1 ? process.argv[projectFlag + 1] : undefined);
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(2);
}
const GROUPS = rotationGroups(project.agentIds);

/**
 * The control plane that enrolls this project holds a copy of its wake
 * trigger as WAKE_TRIGGER_TOKEN_<PROJECT> (spec 0006 §9). A rotation of
 * that group must write the copy too, or the fleet console's wake
 * button for this project breaks silently. The copy lives on ANOTHER
 * project's Worker, which the gateway rotation cannot reach, so the
 * group is rotated DIRECTLY whenever a host exists: this tool mints
 * the value and writes all four members.
 */
const hostPairs = project.hosts.map(host => ({
  project: host.project,
  // The host's plane may live in ANOTHER Cloudflare account: the write
  // selects it explicitly, or wrangler would target the active context.
  accountId: host.accountId,
  workerName: `${host.workerPrefix}-gatekeeper-ops`,
  secretName: `WAKE_TRIGGER_TOKEN_${project.manifest.project.toUpperCase().replace(/-/g, "_")}`
}));
const hostPair = hostPairs.length > 0 ? hostPairs : undefined;

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

/**
 * The ops gateway URL, exactly as tail-wake discovers it. Distinguishes
 * "this colony has no gateway" (its config does not exist: direct
 * writes cannot race anything) from every other case, where a gateway
 * that might rotate concurrently must be assumed to exist.
 */
function opsUrl() {
  if (process.env.OPERON_OPS_URL) return { kind: "url", url: process.env.OPERON_OPS_URL };
  return { kind: "url", url: project.opsUrl };
}

/**
 * Rotate through the gateway (serialized, durable resume). Returns true
 * when the gateway handled it; false ONLY when direct writes provably
 * cannot race a gateway rotation (no gateway config, or the gateway's
 * secrets tools are unconfigured). Every other failure ABORTS: a
 * bypassed serialization can split a group, and --direct exists for
 * the operator who knows nothing is in flight.
 */
async function rotateViaGateway(groups) {
  const ops = opsUrl().url;
  let token;
  try {
    token = execFileSync("cloudflared", ["access", "token", "--app", ops], {
      encoding: "utf8"
    }).trim();
  } catch {
    console.error(
      `✗ no Access session for ${ops} (run: cloudflared access login ${ops}).\n` +
        "not falling back: the gateway may be rotating concurrently and a direct write " +
        "could interleave with it; pass --direct only if no console/MCP rotation can be in flight"
    );
    process.exit(1);
  }
  for (const name of groups) {
    const response = await fetch(`${ops}/api/v1/secret-rotate-group`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
      body: JSON.stringify({ group: name })
    });
    const body = await response.json().catch(() => ({}));
    // The ONLY 503 that makes direct writes safe is "secrets tools are
    // unconfigured" (no CLOUDFLARE_API_TOKEN): a gateway that cannot
    // rotate cannot race us. Any other 503 (audit down, rotation gate
    // unbound, transient outage) means gateway rotations may still be
    // possible or in flight, and a direct write could interleave with
    // one; abort instead of bypassing the serialization.
    if (response.status === 503 && String(body.detail ?? "").includes("CLOUDFLARE_API_TOKEN")) {
      console.log("gateway secrets tools unconfigured; falling back to direct wrangler writes");
      return false;
    }
    if (!response.ok) {
      console.error(
        `✗ ${name}: gateway answered ${response.status}: ${JSON.stringify(body).slice(0, 300)}\n` +
          `not falling back (a direct write could interleave with a gateway rotation); ` +
          `retry, or use --direct only when no console/MCP rotation can be in flight`
      );
      process.exit(1);
    }
    console.log(`→ rotated "${name}" via the gateway (${(body.written ?? []).length} member(s))`);
  }
  return true;
}

function putDirect(workerKey, secretName, value) {
  execFileSync(
    "npx",
    ["wrangler", "secret", "put", secretName, "--name", project.workerName(workerKey)],
    { cwd: ROOT, input: value, stdio: ["pipe", "inherit", "inherit"] }
  );
}

const viaGateway = selected.filter(name => !(name === "wake-trigger" && hostPair));
const directOnly = selected.filter(name => name === "wake-trigger" && hostPair);
if (directOnly.length > 0) {
  console.log(
    `wake-trigger is rotated directly: ${hostPairs.map(pair => pair.project).join(", ")} enroll(s) this project and hold(s) ` +
      `${hostPairs[0].secretName} on ${hostPairs.map(pair => pair.workerName).join(", ")}, which only a direct write reaches`
  );
}

if (!direct && viaGateway.length > 0 && !(await rotateViaGateway(viaGateway))) {
  // The gateway is unconfigured: everything goes direct below.
  directOnly.push(...viaGateway.filter(name => !directOnly.includes(name)));
} else if (!direct) {
  if (viaGateway.length > 0) console.log(`\n✓ rotated via the gateway: ${viaGateway.join(", ")}`);
  if (directOnly.length === 0) {
    console.log(`\n✓ rotated: ${selected.join(", ")} (values never printed; secrets survive deploys)`);
    process.exit(0);
  }
}
const toRotate = direct ? selected : directOnly;

for (const name of toRotate) {
  const value = randomBytes(32).toString("hex");
  const extra = name === "wake-trigger" && hostPair ? hostPairs : [];
  console.log(`\n→ rotating "${name}" across ${GROUPS[name].length + extra.length} worker(s) (direct)`);
  const written = [];
  try {
    for (const [workerKey, secretName] of GROUPS[name]) {
      console.log(`  ${project.workerName(workerKey)} · ${secretName}`);
      putDirect(workerKey, secretName, value);
      written.push(`${project.workerName(workerKey)}:${secretName}`);
    }
    for (const pair of extra) {
      console.log(`  ${pair.workerName} · ${pair.secretName} (${pair.project}'s copy, account ${pair.accountId})`);
      execFileSync("npx", ["wrangler", "secret", "put", pair.secretName, "--name", pair.workerName], {
        cwd: ROOT,
        input: value,
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: pair.accountId },
        stdio: ["pipe", "inherit", "inherit"]
      });
      written.push(`${pair.workerName}:${pair.secretName}`);
    }
  } catch (error) {
    // A partial write is named member by member so a retry finishes it
    // (the retry mints a new value and writes every member again).
    console.error(
      `✗ "${name}" partially rotated: written ${written.join(", ") || "nothing"}; ` +
        `the rest still hold the old value. Re-run --only ${name} --direct. (${String(error.message ?? error).slice(0, 200)})`
    );
    process.exit(1);
  }
}

console.log(`\n✓ rotated: ${selected.join(", ")} (values never printed; secrets survive deploys)`);
