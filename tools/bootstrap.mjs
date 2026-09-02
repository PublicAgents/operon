#!/usr/bin/env node
/**
 * Turn a fresh project into a running one (spec 0006 §4), from the
 * project repo root:
 *
 *   node operon/tools/bootstrap.mjs [--project <name>] [--skip-deploy] [--skip-repos]
 *
 * Idempotent: every step reads before it writes, re-running converges
 * and reports, nothing is created twice. Each line is one of
 *   ✓ present      already there
 *   + created      made now
 *   ! needs you    something only the operator can do, said precisely
 *
 * In order: the zone, the D1 database, the site-store KV namespace, the
 * agents' state repos (seeded from the charters), the deploy itself,
 * email routing to the email Gatekeeper (the Worker must exist first),
 * the secrets checklist (names only, compared with what the Workers
 * hold), and the enrollment snippet for the control plane's host.
 *
 * Needs: `wrangler login` on the project's account; CLOUDFLARE_API_TOKEN
 * (account-scoped: Zone:Read, Email Routing Rules:Edit, Workers Scripts:Read)
 * for the zone and email-routing steps, which are skipped with a named
 * line without it; `gh auth login` for the state repos.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "./colony.mjs";

const CHASSIS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const projectFlag = args.indexOf("--project");
const onlyProject = projectFlag !== -1 ? args[projectFlag + 1] : undefined;

let project;
try {
  project = await loadProject(ROOT, onlyProject);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(2);
}
const { manifest, workerName } = project;
const { requiredSecrets, secretsByWorker } = await import(
  join(CHASSIS_ROOT, "packages/fleet/dist/index.js")
);

const API = "https://api.cloudflare.com/client/v4";
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const needs = [];
const present = message => console.log(`  ✓ ${message}`);
const created = message => console.log(`  + ${message}`);
const needYou = message => {
  needs.push(message);
  console.log(`  ! ${message}`);
};

function run(cmd, cmdArgs, options = {}) {
  return execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

/** A wrangler --json payload, with the banner cut away (see fleet.mjs). */
function wranglerJson(cmdArgs, { jsonFlag = true } = {}) {
  const out = run("npx", ["wrangler", ...cmdArgs, ...(jsonFlag ? ["--json"] : [])]);
  const start = out.search(/[[{]/);
  const end = Math.max(out.lastIndexOf("]"), out.lastIndexOf("}"));
  if (start === -1 || end < start) throw new Error(`wrangler ${cmdArgs.join(" ")} answered no JSON`);
  const body = JSON.parse(out.slice(start, end + 1));
  return Array.isArray(body) ? body : (body.result ?? body);
}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const detail = (payload.errors ?? []).map(error => error.message).join("; ") || `${response.status}`;
    throw new Error(`${method} ${path}: ${detail}`);
  }
  return payload.result;
}

console.log(`\n=== bootstrap ${manifest.project} (${manifest.roster.zone}) ===`);

// ---- 0. the account ---------------------------------------------------
{
  const who = run("npx", ["wrangler", "whoami"]);
  if (!who.includes(manifest.accountId)) {
    console.error(
      `✗ wrangler is not logged in to account ${manifest.accountId} (the manifest's accountId); ` +
        `run wrangler login, or set CLOUDFLARE_ACCOUNT_ID`
    );
    process.exit(2);
  }
  present(`wrangler reaches account ${manifest.accountId}`);
}

// ---- 1. the zone ------------------------------------------------------
let zoneId = null;
console.log("\nzone");
if (!apiToken) {
  needYou(
    `CLOUDFLARE_API_TOKEN is not set: the zone and email-routing steps need it (Zone:Read, ` +
      `Email Routing Rules:Edit). Verify by hand that ${manifest.roster.zone} is on the account.`
  );
} else {
  const zones = await api(
    "GET",
    `/zones?name=${encodeURIComponent(manifest.roster.zone)}&account.id=${manifest.accountId}`
  );
  if (zones.length === 0) {
    needYou(
      `add the zone ${manifest.roster.zone} to account ${manifest.accountId} (Cloudflare dashboard, ` +
        `Add a site) and point the registrar's nameservers at it; delete parking records. Then re-run.`
    );
  } else {
    zoneId = zones[0].id;
    present(`zone ${manifest.roster.zone} (${zones[0].status})`);
    if (zones[0].status !== "active") {
      needYou(`the zone is "${zones[0].status}": nameservers at the registrar are not pointing at Cloudflare yet`);
    }
  }
}

// ---- 2. D1 -------------------------------------------------------------
console.log("\nD1");
{
  const listed = wranglerJson(["d1", "list"]);
  const name = manifest.resources.d1Name;
  if (listed.some(db => db.name === name)) {
    present(`database ${name}`);
  } else {
    run("npx", ["wrangler", "d1", "create", name]);
    created(`database ${name}`);
  }
}

// ---- 3. the site-store KV namespace ---------------------------------
console.log("\nKV");
{
  const title = `${manifest.workerPrefix}-site`;
  if (manifest.resources.siteStoreKvId) {
    present(`site store pinned by id in the manifest (${manifest.resources.siteStoreKvId})`);
  } else {
    const listed = wranglerJson(["kv", "namespace", "list"]);
    if (listed.some(ns => ns.title === title)) {
      present(`namespace ${title}`);
    } else {
      run("npx", ["wrangler", "kv", "namespace", "create", title]);
      created(`namespace ${title}`);
    }
  }
}

// ---- 4. the agents' state repos -------------------------------------
console.log("\nstate repos");
if (flag("--skip-repos")) {
  console.log("  (skipped: --skip-repos)");
} else {
  for (const agent of manifest.roster.agents) {
    const repo = agent.stateRepo;
    const charter = [
      join(ROOT, ".operon/charters", `${agent.id}.md`),
      join(ROOT, "charters", `${agent.id}.md`)
    ].find(existsSync);
    const exists = spawnSync("gh", ["repo", "view", repo, "--json", "name"], { encoding: "utf8" }).status === 0;
    if (!exists) {
      const made = spawnSync("gh", ["repo", "create", repo, "--private"], { encoding: "utf8" });
      if (made.status !== 0) {
        needYou(`create the state repo ${repo} for ${agent.id} (gh could not: ${made.stderr.trim().slice(0, 200)})`);
        continue;
      }
      created(`repo ${repo}`);
    } else {
      present(`repo ${repo}`);
    }
    const has = path =>
      spawnSync("gh", ["api", `repos/${repo}/contents/${path}`], { encoding: "utf8" }).status === 0;
    if (!has("CHARTER.md")) {
      if (!charter) {
        needYou(`seed ${repo} with CHARTER.md: no charter found at .operon/charters/${agent.id}.md or charters/${agent.id}.md`);
      } else {
        putFile(repo, "CHARTER.md", readFileSync(charter), `Seed the charter for ${agent.id}`);
        created(`${repo}/CHARTER.md from ${charter.replace(ROOT + "/", "")}`);
      }
    } else {
      present(`${repo}/CHARTER.md`);
    }
    if (!has("NOTES.md")) {
      putFile(repo, "NOTES.md", Buffer.from(""), `Start ${agent.id}'s notes`);
      created(`${repo}/NOTES.md (empty)`);
    } else {
      present(`${repo}/NOTES.md`);
    }
  }
}

function putFile(repo, path, content, message) {
  const result = spawnSync(
    "gh",
    ["api", "-X", "PUT", `repos/${repo}/contents/${path}`, "-f", `message=${message}`, "-f", `content=${content.toString("base64")}`],
    { encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(`could not write ${repo}/${path}: ${result.stderr.trim().slice(0, 200)}`);
}

// ---- 5. the deploy ----------------------------------------------------
console.log("\ndeploy");
const opsWorker = workerName("gatekeeper-ops");
let deployed = false;
if (flag("--skip-deploy")) {
  console.log("  (skipped: --skip-deploy)");
} else if (!zoneId && apiToken) {
  needYou("the deploy needs the zone (custom-domain routes); add it and re-run");
} else {
  // A first deploy has nothing to drain and no ops gateway to ask, so
  // it runs without the drain; every later one drains as usual. Only a
  // DEFINITE absence skips the drain: any doubt (a failed lookup, a
  // token without scope) drains, because the wrong guess here kills
  // running wakes.
  const first = (await workerExists(opsWorker)) === false;
  const deploy = spawnSync(
    "node",
    [join(CHASSIS_ROOT, "tools/fleet.mjs"), "deploy", "--project", manifest.project, ...(first ? ["--no-drain"] : [])],
    { cwd: ROOT, stdio: "inherit" }
  );
  if (deploy.status !== 0) {
    needYou("the deploy failed (see above); fix and re-run bootstrap, it resumes where it is");
  } else {
    deployed = true;
    created(first ? "first deploy (no drain: nothing was running)" : "deploy");
  }
}

/**
 * true when the Worker exists, false when it DEFINITELY does not (the
 * API or wrangler said not found), and "unknown" for every other
 * failure. Callers treat unknown as existing where the safe direction
 * is to assume the fleet is live.
 */
async function workerExists(name) {
  if (apiToken) {
    try {
      await api("GET", `/accounts/${manifest.accountId}/workers/scripts/${name}`);
      return true;
    } catch (error) {
      return /not found|10007|\b404\b/i.test(String(error.message)) ? false : "unknown";
    }
  }
  // Without the API, ask wrangler by way of the rendered config.
  const config = join(ROOT, ".operon/build", manifest.project, "gatekeeper-ops.json");
  if (!existsSync(config)) return "unknown";
  const asked = spawnSync("npx", ["wrangler", "deployments", "list", "-c", config], { cwd: ROOT, encoding: "utf8" });
  if (asked.status === 0) return true;
  return /not found|10007/i.test(`${asked.stdout}${asked.stderr}`) ? false : "unknown";
}

// ---- 6. email routing --------------------------------------------------
console.log("\nemail routing");
if (!apiToken || !zoneId) {
  needYou(
    `enable Email Routing on ${manifest.roster.zone} and set the catch-all rule to the Worker ` +
      `${workerName("gatekeeper-email")} (dashboard: Email Routing → Routing rules)`
  );
} else {
  const routing = await api("GET", `/zones/${zoneId}/email/routing`);
  if (routing.enabled) {
    present("Email Routing enabled");
  } else {
    await api("POST", `/zones/${zoneId}/email/routing/enable`);
    created("Email Routing enabled (MX, SPF and DKIM records added by Cloudflare)");
  }
  const emailWorker = workerName("gatekeeper-email");
  const catchAll = await api("GET", `/zones/${zoneId}/email/routing/rules/catch_all`);
  const routed =
    catchAll.enabled &&
    (catchAll.actions ?? []).some(action => action.type === "worker" && (action.value ?? []).includes(emailWorker));
  if (routed) {
    present(`catch-all → ${emailWorker}`);
  } else if (!deployed && (await workerExists(emailWorker)) !== true) {
    needYou(`the catch-all rule needs the Worker ${emailWorker} to exist: deploy, then re-run`);
  } else {
    await api("PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
      enabled: true,
      name: "operon: every address to the email Gatekeeper",
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [emailWorker] }]
    });
    created(`catch-all → ${emailWorker}`);
  }
}

// ---- 7. the secrets checklist ---------------------------------------
console.log("\nsecrets (names only; values never pass through here)");
{
  const buildDir = join(ROOT, ".operon/build", manifest.project);
  const rendered = existsSync(buildDir) ? new Set(readdirSync(buildDir).map(file => file.replace(/\.json$/, ""))) : new Set();
  const grouped = secretsByWorker(requiredSecrets(manifest));
  let missingRequired = 0;
  for (const [worker, requirements] of grouped) {
    const config = join(buildDir, `${worker}.json`);
    const names = requirements.map(r => r.name).join(", ");
    if (!rendered.has(worker)) {
      console.log(`  ? ${worker}: not rendered yet (npm run render); needs ${names}`);
      continue;
    }
    let held;
    try {
      // `wrangler secret list` prints JSON and takes no --json flag.
      held = new Set(wranglerJson(["secret", "list", "-c", config], { jsonFlag: false }).map(entry => entry.name));
    } catch (error) {
      const said = String(error.stderr ?? error.message ?? error);
      const reason = /not found|10007/i.test(said)
        ? "not deployed yet"
        : /authenticate|10000|10001/i.test(said)
          ? "this login cannot list secrets (needs Workers Scripts:Read); deploy CI's token can"
          : `wrangler could not list its secrets (${said.replace(/\s+/g, " ").slice(0, 120)})`;
      console.log(`  ? ${worker}: ${reason}; needs ${names}`);
      continue;
    }
    const missing = requirements.filter(r => !held.has(r.name));
    if (missing.length === 0) {
      present(`${worker}: all ${requirements.length} present`);
      continue;
    }
    for (const requirement of missing) {
      const line = `${worker}: ${requirement.name}${requirement.optional ? " (optional)" : ""}: ${requirement.purpose}`;
      if (requirement.optional) console.log(`  · ${line}`);
      else {
        missingRequired += 1;
        needYou(line);
      }
    }
  }
  if (missingRequired > 0) {
    console.log(
      `\n  set each with: npx wrangler secret put <NAME> -c .operon/build/${manifest.project}/<worker>.json` +
        `  (internal bearers: npm run rotate:tokens -- --only <group>, which mints every member at once)`
    );
  }
}

// ---- 8. enrollment in the control plane -------------------------------
console.log("\ncontrol plane (spec 0006 §9)");
// Every project renders its own ops worker; what makes one THE fleet's
// plane is enrolling the others. A project enrolling none is either
// the plane of a one-project fleet or a project to be enrolled
// elsewhere, and the manifest cannot tell which, so both are said.
if (manifest.control.enrolled.length > 0) {
  present(`this project's plane reaches ${manifest.control.enrolled.length} enrolled project(s)`);
} else {
  console.log(
    `  → this project's plane reaches itself only. To run ONE console for the fleet, either enroll the\n` +
      `    other projects under control.projects here, or enroll ${manifest.project} in the hosting\n` +
      `    project's manifest:\n` +
      `      control:\n        projects:\n          - project: ${manifest.project}\n            zone: ${manifest.roster.zone}\n` +
      (manifest.workerPrefix !== `operon-${manifest.project}` ? `            workerPrefix: ${manifest.workerPrefix}\n` : "") +
      `    then set WAKE_TRIGGER_TOKEN_${manifest.project.toUpperCase().replace(/-/g, "_")} on the host's ops worker\n` +
      `    to the value of this project's scheduler WAKE_TRIGGER_TOKEN, and deploy the host.`
  );
}

console.log(
  needs.length === 0
    ? `\n✓ ${manifest.project}: bootstrapped; nothing left for you here`
    : `\n${needs.length} thing(s) need you (the ! lines above); re-run after each, it converges`
);
process.exit(needs.length === 0 ? 0 : 1);
