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

/**
 * How long a deploy may wait for running wakes to finish. Bounded by
 * the colony's maximum wake length: past this, something is wrong
 * with the wake, not with the deploy.
 */
const DRAIN_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * How long ONE worker's wrangler deploy may take. Enforced, so the
 * deploy phase has a real upper bound rather than an assumed one. The
 * bound exists to stop a HUNG deploy from holding the pause forever,
 * not to police a slow one, so it is set well above what a healthy
 * deploy needs: a large bundle on a slow link is a legitimate deploy,
 * and killing it mid-sequence leaves the colony half-deployed.
 */
const WORKER_DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The same, for a worker that carries a CONTAINER image. That deploy
 * builds and pushes the image, which is a different order of magnitude
 * from uploading a script: a cold build of the wake container takes
 * many minutes, and a Dockerfile change makes every deploy a cold one.
 */
const CONTAINER_DEPLOY_TIMEOUT_MS = 45 * 60 * 1000;

/** Room for the work the enforced limits do not cover (see below). */
const QUEUE_SLACK_MS = 5 * 60 * 1000;

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

/**
 * How long a deploy may queue behind ANOTHER deploy's pause: the
 * holder's entire ENFORCED lifetime, computed rather than guessed
 * (its full drain, plus every worker taking its full deploy timeout).
 * A holder cannot legitimately exceed this, so a queue that reaches
 * it is looking at a stuck pause and says so.
 */
const QUEUE_TIMEOUT_MS =
  DRAIN_TIMEOUT_MS +
  (DEPLOY_ORDER.length - 1) * WORKER_DEPLOY_TIMEOUT_MS +
  CONTAINER_DEPLOY_TIMEOUT_MS +
  // The enforced limits bound the WAITS, not the work between them:
  // drain polling, spawning wrangler once per worker, and the resume
  // round trip all happen outside them. Without slack, a holder that
  // used its full allowance would be declared stuck for the seconds it
  // spent on that overhead, and calling a healthy deploy stuck is the
  // expensive direction to be wrong in.
  QUEUE_SLACK_MS;

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
  if (!response.ok) {
    const error = new Error(`${tool} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
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
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
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
  const workersByKey = new Map(workers.map(worker => [worker.key, worker]));
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
      // Another deploy (CI and a laptop can both be pushed at once)
      // holds the pause: QUEUE behind it rather than failing, since
      // both deploys are legitimate and the loser would otherwise have
      // to be re-run by hand. Bounded, so a genuinely stuck pause
      // still surfaces instead of hanging forever.
      const queueDeadline = Date.now() + QUEUE_TIMEOUT_MS;
      for (;;) {
        try {
          await opsCall(manifest, "fleet-pause", { reason: "deploy in progress", token: drainToken });
          break;
        } catch (error) {
          if (error.status !== 409) throw error;
          if (Date.now() > queueDeadline) {
            throw new Error(
              `the fleet pause has been held longer than a deploy can legitimately hold it ` +
                `(${Math.round(QUEUE_TIMEOUT_MS / 60000)} min); it is stuck. Verify with agents-list ` +
                `(paused field) and clear it with fleet_resume (force: true).`
            );
          }
          console.log("  another deploy holds the fleet pause; waiting for it to finish");
          await new Promise(resolve => setTimeout(resolve, 20_000));
        }
      }
      paused = true;
      console.log("  fleet paused: new wakes defer; running wakes finish undisturbed");
    } catch (error) {
      // The pause may have COMMITTED with its response lost. The
      // tokened resume is the safe probe-and-undo: it clears exactly a
      // pause held by OUR token, is refused for another holder's, and
      // is a no-op when none exists.
      await opsCall(manifest, "fleet-resume", { token: drainToken }).catch(() => undefined);
      fail(
        `cannot pause the fleet (${String(error.message ?? error).slice(0, 200)})\n` +
          `A best-effort resume for this deploy's token was attempted in case the pause\n` +
          `committed with a lost response; verify with agents-list (paused field) and\n` +
          `recover with fleet_resume (force: true) if wakes are still deferred.\n` +
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
  // One deterministic exit path: the deploy error is CAUGHT and
  // recorded (never left to propagate past the reporting below), the
  // resume always runs when a pause was taken, and the final report
  // names every failure that occurred, the stuck-pause recovery first
  // because it is the one that costs wakes every hour it is missed.
  // The WHOLE roster, mcp defs included: the scheduler resolves MCP
  // grants and the umbilical routes from this var, so an entry dropped
  // here is a capability that validates at check and vanishes in prod.
  const rosterVar = JSON.stringify({
    zone: manifest.roster.zone,
    agents: manifest.roster.agents,
    ...(manifest.roster.mcp !== undefined ? { mcp: manifest.roster.mcp } : {})
  });
  let deployError = null;
  try {
    if (paused) await waitForQuiet(manifest);
    for (const key of DEPLOY_ORDER) {
      console.log(`\n→ deploying ${manifest.project}/${key}`);
      // A worker carrying a container image gets the image-build bound;
      // read from the rendered config, so adding a container to another
      // worker cannot leave it on the script-sized timeout.
      const carriesContainer = Boolean(
        workersByKey.get(key)?.config.containers?.length
      );
      execFileSync(
        "npx",
        ["wrangler", "deploy", "-c", join(buildDir, `${key}.json`), "--var", `ROSTER:${rosterVar}`],
        {
          cwd: PROJECT_ROOT,
          stdio: "inherit",
          timeout: carriesContainer ? CONTAINER_DEPLOY_TIMEOUT_MS : WORKER_DEPLOY_TIMEOUT_MS
        }
      );
    }
  } catch (error) {
    deployError = error;
  }
  if (paused) {
    resumeFailed = await opsCall(manifest, "fleet-resume", { token: drainToken }).then(
      () => (console.log("  fleet resumed"), false),
      error => (console.error(`  resume error: ${error}`), true)
    );
  }
  if (resumeFailed || deployError) {
    fail(
      (resumeFailed
        ? `the fleet is STILL PAUSED (the resume failed) and wakes are deferred.\n` +
          `Recover with the fleet_resume tool (force: true) on the ops console or API.\n`
        : "") +
        (deployError ? `deploy failed: ${String(deployError.message ?? deployError).slice(0, 300)}` : "")
    );
  }
  console.log(`\n✓ ${manifest.project}: deploy complete`);
}
