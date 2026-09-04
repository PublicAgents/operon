#!/usr/bin/env node
/**
 * Sign the dedicated Grok account into Grok Build CLI and put the login
 * straight into the scheduler's MIND_CREDENTIAL_GROK secret, never
 * printed, never on argv (spec 0010 §5):
 *
 *   node operon/tools/grok-authorize.mjs [--project <name>] [--device-auth]
 *
 * Runs `grok login` under a TEMPORARY home (so the operator's own
 * ~/.grok is untouched and no other login is mixed in), then pipes the
 * resulting auth.json into `wrangler secret put`. Pass --device-auth on
 * a machine without a browser (Grok's device-code flow). The temporary
 * home is deleted afterwards whatever happened.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "./colony.mjs";

// Chassis tooling, project data: run from a PROJECT checkout's root.
const ROOT = process.cwd();
const projectFlag = process.argv.indexOf("--project");
const deviceAuth = process.argv.includes("--device-auth");
let project;
try {
  project = await loadProject(ROOT, projectFlag !== -1 ? process.argv[projectFlag + 1] : undefined);
} catch (error) {
  console.error(String(error.message ?? error));
  process.exit(2);
}

const usesGrok = project.manifest.roster.agents.some(
  agent => agent.harness === "grok" || Object.keys(agent.harnesses ?? {}).includes("grok")
);
if (!usesGrok) {
  console.error(
    `no agent in project "${project.manifest.project}" names the grok harness (agents[].harness or agents[].harnesses.grok); nothing to authorize`
  );
  process.exit(2);
}

const version = spawnSync("grok", ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
  console.error("grok CLI not found on PATH: npm install -g @xai-official/grok, then re-run");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "operon-grok-"));
try {
  console.log(`signing in with a temporary Grok home (${version.stdout.trim()}); use the DEDICATED Grok account, not your own`);
  const login = spawnSync("grok", ["login", ...(deviceAuth ? ["--device-auth"] : [])], {
    stdio: "inherit",
    env: { ...process.env, GROK_HOME: home }
  });
  if (login.status !== 0) {
    console.error(`grok login exited ${login.status}`);
    process.exit(1);
  }
  const authPath = join(home, "auth.json");
  let auth;
  try {
    auth = readFileSync(authPath, "utf8");
  } catch {
    console.error("grok login left no auth.json");
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(auth);
  } catch {
    console.error("auth.json is not JSON");
    process.exit(1);
  }
  const hasAccess = typeof parsed?.access_token === "string" && parsed.access_token.length > 0;
  const hasIssuerKey =
    parsed &&
    typeof parsed === "object" &&
    Object.values(parsed).some(
      entry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.key === "string" &&
        entry.key.length > 0
    );
  if (!hasAccess && !hasIssuerKey) {
    console.error("auth.json carries no grok login (no access_token, no issuer entry with a key)");
    process.exit(1);
  }
  const bytes = statSync(authPath).size;
  if (bytes > 5 * 1024) {
    console.error(`auth.json is ${bytes} bytes; a Cloudflare secret holds at most 5 KB`);
    process.exit(1);
  }
  console.log(`login ok (${bytes} bytes); storing MIND_CREDENTIAL_GROK on ${project.workerName("scheduler")} (value never shown)…`);
  execFileSync(
    "npx",
    ["wrangler", "secret", "put", "MIND_CREDENTIAL_GROK", "--name", project.workerName("scheduler")],
    { cwd: ROOT, input: auth, stdio: ["pipe", "inherit", "inherit"] }
  );
  console.log(
    "\n✓ MIND_CREDENTIAL_GROK stored. Grok may refresh this login inside a wake; the chassis" +
      "\n  watches the rewrite for the denylist and does not persist it (spec 0010 §5). Re-run this" +
      "\n  after a sign-out, a revoked session, or a wake that can no longer authenticate. Wake an" +
      "\n  agent on grok with the console's harness picker or the wake tool's harness field."
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}
