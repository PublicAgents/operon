#!/usr/bin/env node
/**
 * Sign the dedicated ChatGPT account into Codex CLI and put the login
 * straight into the scheduler's MIND_CREDENTIAL_CODEX secret, never
 * printed, never on argv (spec 0010 §5):
 *
 *   node operon/tools/codex-authorize.mjs [--project <name>] [--device-auth]
 *
 * Runs `codex login` under a TEMPORARY home (so the operator's own
 * ~/.codex is untouched and no other login is mixed in), then pipes the
 * resulting auth.json into `wrangler secret put`. Pass --device-auth on
 * a machine without a browser (Codex's device-code flow; enable it in
 * the account's security settings first). The temporary home is deleted
 * afterwards whatever happened.
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

const usesCodex = project.manifest.roster.agents.some(
  agent => agent.harness === "codex" || Object.keys(agent.harnesses ?? {}).includes("codex")
);
if (!usesCodex) {
  console.error(
    `no agent in project "${project.manifest.project}" names the codex harness (agents[].harness or agents[].harnesses.codex); nothing to authorize`
  );
  process.exit(2);
}

const version = spawnSync("codex", ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
  console.error("codex CLI not found on PATH: npm install -g @openai/codex, then re-run");
  process.exit(2);
}

// A temporary CODEX_HOME: Codex requires it to exist already.
const home = mkdtempSync(join(tmpdir(), "operon-codex-"));
try {
  console.log(`signing in with a temporary Codex home (${version.stdout.trim()}); use the DEDICATED ChatGPT account, not your own`);
  const login = spawnSync("codex", ["login", ...(deviceAuth ? ["--device-auth"] : [])], {
    stdio: "inherit",
    env: { ...process.env, CODEX_HOME: home }
  });
  if (login.status !== 0) {
    console.error(`codex login exited ${login.status}`);
    process.exit(1);
  }
  const authPath = join(home, "auth.json");
  let auth;
  try {
    auth = readFileSync(authPath, "utf8");
  } catch {
    console.error("codex login left no auth.json (a keyring store? set cli_auth_credentials_store = \"file\")");
    process.exit(1);
  }
  const parsed = JSON.parse(auth);
  if (typeof parsed?.tokens !== "object" || parsed.tokens === null) {
    console.error("auth.json carries no tokens table; not a ChatGPT login");
    process.exit(1);
  }
  const bytes = statSync(authPath).size;
  if (bytes > 5 * 1024) {
    console.error(`auth.json is ${bytes} bytes; a Cloudflare secret holds at most 5 KB`);
    process.exit(1);
  }
  console.log(`login ok (${bytes} bytes); storing MIND_CREDENTIAL_CODEX on ${project.workerName("scheduler")} (value never shown)…`);
  execFileSync(
    "npx",
    ["wrangler", "secret", "put", "MIND_CREDENTIAL_CODEX", "--name", project.workerName("scheduler")],
    { cwd: ROOT, input: auth, stdio: ["pipe", "inherit", "inherit"] }
  );
  console.log(
    "\n✓ MIND_CREDENTIAL_CODEX stored. Codex refreshes this login in place after eight days; the chassis" +
      "\n  relays the refreshed copy back from the wake (spec 0010 §5), so re-run this only after a" +
      "\n  sign-out or a revoked session. Wake an agent on codex with the console's harness picker or" +
      "\n  the wake tool's harness field."
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}
