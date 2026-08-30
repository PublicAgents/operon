#!/usr/bin/env node
/**
 * The fleet deploy driver (spec 0006): run from a project repo root.
 *
 *   node operon/tools/fleet.mjs check   [--project <name>]
 *   node operon/tools/fleet.mjs render  [--project <name>]
 *   node operon/tools/fleet.mjs deploy  [--project <name>] [--no-drain]
 *
 * The manifest is `.operon/operon.yaml` (single project) or
 * `.operon/projects/<name>/operon.yaml` (several). Configs render from
 * the CHASSIS-owned templates into `.operon/build/<project>/`; the
 * colony repo carries no wrangler files.
 *
 * Deploys never kill running wakes (spec 0006 §5): every deploy
 * DRAINS, because image rebuilds are not reproducible and a wrong
 * "no roll" guess kills wakes. The driver PAUSES new wake starts
 * through the ops gateway (fleet_pause defers and never touches a
 * wake in flight), waits for the current-wake set to empty, deploys,
 * and resumes in a finally whatever happens. Draining needs
 * OPERON_OPS_URL plus either an interactive `cloudflared` login or
 * CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET (a service token); a
 * scheduler deploy REFUSES without them unless --no-drain says, in
 * effect, kill whatever is running.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHASSIS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = process.cwd();

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function loadFleet() {
  const entry = join(CHASSIS_ROOT, "packages/fleet/dist/index.js");
  try {
    return await import(entry);
  } catch {
    fail(`cannot import the chassis fleet package from ${entry}\nBuild the submodule first (npm run build:chassis).`);
  }
}

const [, , command, ...rest] = process.argv;
if (!["check", "render", "deploy"].includes(command ?? "")) {
  fail("usage: fleet.mjs <check|render|deploy> [--project <name>] [--no-drain]");
}
const projectFlagIndex = rest.indexOf("--project");
const onlyProject = projectFlagIndex >= 0 ? rest[projectFlagIndex + 1] : undefined;
const noDrain = rest.includes("--no-drain");

const { parseManifest, renderWorkers, DEPLOY_ORDER, D1_PLACEHOLDER } = await loadFleet();

/** Locate every manifest in the repo (spec 0006 §1 layouts). */
function findManifests() {
  const single = join(PROJECT_ROOT, ".operon/operon.yaml");
  const multiDir = join(PROJECT_ROOT, ".operon/projects");
  const found = [];
  if (existsSync(single)) found.push({ path: single, directoryName: undefined });
  if (existsSync(multiDir)) {
    for (const name of readdirSync(multiDir)) {
      const path = join(multiDir, name, "operon.yaml");
      if (existsSync(path)) found.push({ path, directoryName: name });
    }
  }
  if (found.length === 0) fail("no .operon/operon.yaml or .operon/projects/*/operon.yaml found here");
  return found;
}

const manifests = findManifests()
  .map(({ path, directoryName }) => {
    try {
      return parseManifest(readFileSync(path, "utf8"), { directoryName });
    } catch (error) {
      fail(String(error.message ?? error));
    }
  })
  .filter(manifest => onlyProject === undefined || manifest.project === onlyProject);
if (manifests.length === 0) fail(`no project named "${onlyProject}" here`);

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: PROJECT_ROOT, encoding: "utf8", ...options });
}

function resolveD1Id(manifest) {
  const listed = JSON.parse(run("npx", ["wrangler", "d1", "list", "--json"]));
  const match = listed.find(db => db.name === manifest.resources.d1Name);
  if (!match) fail(`D1 database "${manifest.resources.d1Name}" does not exist in the account; run bootstrap first`);
  return match.uuid;
}

function resolveKvId(manifest) {
  if (manifest.resources.siteStoreKvId) return manifest.resources.siteStoreKvId;
  const listed = JSON.parse(run("npx", ["wrangler", "kv", "namespace", "list"]));
  const title = `${manifest.workerPrefix}-site`;
  const match = listed.find(ns => ns.title === title);
  if (!match) {
    fail(`KV namespace titled "${title}" does not exist and resources.siteStoreKvId is unset; run bootstrap or set the id`);
  }
  return match.id;
}

function render(manifest, { resolveIds }) {
  const buildDir = join(PROJECT_ROOT, ".operon/build", manifest.project);
  mkdirSync(buildDir, { recursive: true });
  const options = {
    chassisDir: "../../../operon",
    ...(resolveIds ? { d1DatabaseId: resolveD1Id(manifest), siteStoreKvId: resolveKvId(manifest) } : {})
  };
  const workers = renderWorkers(manifest, options);
  for (const worker of workers) {
    writeFileSync(join(buildDir, worker.filename), JSON.stringify(worker.config, null, 2) + "\n");
  }
  return { buildDir, workers };
}

async function opsCall(manifest, tool, body) {
  const opsUrl = process.env.OPERON_OPS_URL ?? `https://ops.${manifest.roster.zone}`;
  const headers = { "content-type": "application/json", "x-operon-console": "1" };
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  } else {
    const token = run("cloudflared", ["access", "token", "-app", opsUrl]).trim();
    headers["cf-access-token"] = token;
  }
  const response = await fetch(`${opsUrl}/api/v1/${tool}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {})
  });
  if (!response.ok) throw new Error(`${tool} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

/**
 * Spec 0006 §5: wait for the current-wake set to be empty on two
 * consecutive polls (the fleet is already paused by the caller; the
 * double read plus the launch-level pause check in the scheduler
 * closes the register-in-flight window). Throws rather than exits, so
 * the caller's finally always gets to resume.
 */
async function waitForQuiet(manifest) {
  const deadline = Date.now() + 45 * 60 * 1000;
  let quietOnce = false;
  for (;;) {
    const { agents: now } = await opsCall(manifest, "agents-list");
    const running = now.filter(agent => agent.currentWake).map(agent => agent.id);
    if (running.length === 0) {
      if (quietOnce) return;
      quietOnce = true;
    } else {
      quietOnce = false;
      console.log(`  waiting for wakes to finish: ${running.join(", ")}`);
    }
    if (Date.now() > deadline) throw new Error(`drain timed out; still running: ${running.join(", ")}`);
    await new Promise(resolve => setTimeout(resolve, quietOnce ? 10_000 : 30_000));
  }
}

for (const manifest of manifests) {
  console.log(`\n=== project ${manifest.project} (${manifest.roster.zone}) ===`);
  const enabled = manifest.roster.agents.filter(agent => agent.enabled);
  console.log(`roster: ${manifest.roster.agents.length} agent(s), ${enabled.length} enabled`);

  if (command === "check") {
    // Validation happened at parse; render without ids proves the
    // templates accept this manifest. Cron coverage is correct by
    // construction now: the triggers derive from the roster itself.
    render(manifest, { resolveIds: false });
    console.log(`✓ ${manifest.project}: manifest valid against this chassis; configs render`);
    continue;
  }

  if (command === "render") {
    const { buildDir } = render(manifest, { resolveIds: true });
    console.log(`✓ rendered into ${buildDir}`);
    continue;
  }

  // deploy
  const consoleIndex = join(CHASSIS_ROOT, "packages/console/dist/index.html");
  if (!existsSync(consoleIndex)) {
    fail("the console build is missing; run build:chassis first (deploying without it ships a blank console)");
  }
  const { buildDir, workers } = render(manifest, { resolveIds: true });
  for (const worker of workers) {
    if (JSON.stringify(worker.config).includes(D1_PLACEHOLDER)) {
      fail(`${worker.key} still carries an unresolved resource id`);
    }
  }

  // Every deploy drains (spec 0006 §5): image rebuilds are not
  // reproducible (base layers and distro packages drift under identical
  // sources), so "this deploy rolls no containers" is unprovable from
  // the repo, and a wrong guess kills wakes. Draining an idle fleet
  // costs seconds; draining a busy one is the entire point.
  const drainToken = `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let resumeFailed = false;
  let paused = false;
  if (!noDrain) {
    try {
      await opsCall(manifest, "fleet-pause", { reason: "deploy in progress", token: drainToken });
      paused = true;
      console.log("  fleet paused: new wakes defer; running wakes finish undisturbed");
    } catch (error) {
      fail(
        `cannot pause the fleet (${String(error.message ?? error).slice(0, 200)})\n` +
          `Deploying may roll the wake image and kill running wakes.\n` +
          `Provide ops access (OPERON_OPS_URL + CF_ACCESS_CLIENT_ID/SECRET or cloudflared login),\n` +
          `wait if another deploy holds the pause, or pass --no-drain to kill whatever is running.`
      );
    }
  } else {
    console.log("--no-drain: proceeding without draining; running wakes may be killed by an image roll");
  }

  // Everything after a successful pause runs under one try: whatever
  // fails (the quiet wait included), the finally resumes THIS deploy's
  // pause by token, so no failure mode leaves the fleet refusing wakes
  // and no overlapping deploy gets its pause released from under it.
  const rosterVar = JSON.stringify({ zone: manifest.roster.zone, agents: manifest.roster.agents });
  try {
    if (paused) await waitForQuiet(manifest);
    for (const key of DEPLOY_ORDER) {
      console.log(`\n→ deploying ${manifest.project}/${key}`);
      execFileSync(
        "npx",
        ["wrangler", "deploy", "-c", join(buildDir, `${key}.json`), "--var", `ROSTER:${rosterVar}`],
        { cwd: PROJECT_ROOT, stdio: "inherit" }
      );
    }
  } finally {
    if (paused) {
      resumeFailed = await opsCall(manifest, "fleet-resume", { token: drainToken }).then(
        () => (console.log("  fleet resumed"), false),
        error => (
          // Full recovery instructions HERE, inside the finally: when
          // the deploy itself also threw, its exception propagates past
          // the post-loop check and this is the only line the operator
          // sees about the stuck pause.
          console.error(
            `  RESUME FAILED, the fleet is STILL PAUSED and wakes are deferred.\n` +
              `  Recover with the fleet_resume tool (force: true) on the ops console or API.\n` +
              `  (${error})`
          ),
          true
        )
      );
    }
  }
  if (resumeFailed) {
    // A deploy that leaves the fleet refusing wakes is NOT a success,
    // whatever the workers say: exit nonzero so automation alarms, and
    // name the recovery.
    fail(
      `workers deployed but the fleet is STILL PAUSED (the resume failed).\n` +
        `Wakes are deferred until you run the fleet_resume tool (force: true) on the ops console or API.`
    );
  }
  console.log(`\n✓ ${manifest.project}: deploy complete`);
}
