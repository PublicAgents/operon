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
