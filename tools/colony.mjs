/**
 * What the operator CLIs need to know about the project they are run
 * in, read from `.operon/operon.yaml` (spec 0006 §1). Before the fleet
 * layout these tools read `roster.jsonc` and addressed Workers through
 * `workers/<dir>/wrangler.jsonc`; neither exists in a project repo any
 * more, so they addressed nothing and exited at the first check.
 *
 * Workers are addressed by NAME here rather than by a config file: the
 * name is derived from the manifest the deploy also renders from, so a
 * secret cannot land on a differently-named Worker than the one the
 * deploy created, and no tool depends on `.operon/build` having been
 * rendered first.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHASSIS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function loadFleet() {
  const entry = join(CHASSIS_ROOT, "packages/fleet/dist/index.js");
  try {
    return await import(entry);
  } catch {
    throw new Error(
      `cannot import the chassis fleet package from ${entry}\n` +
        "Build the submodule first (npm run build:chassis)."
    );
  }
}

/** Every manifest in this repo, in both spec 0006 §1 layouts. */
function findManifests(root) {
  const single = join(root, ".operon/operon.yaml");
  const multiDir = join(root, ".operon/projects");
  const found = [];
  if (existsSync(single)) found.push({ path: single, directoryName: undefined });
  if (existsSync(multiDir)) {
    for (const name of readdirSync(multiDir)) {
      const path = join(multiDir, name, "operon.yaml");
      if (existsSync(path)) found.push({ path, directoryName: name });
    }
  }
  return found;
}

/**
 * The one project these commands act on. A tool that writes secrets
 * must never GUESS which project it is writing to, so several projects
 * without `--project` is an error naming them, not a default.
 */
export async function loadProject(root = process.cwd(), onlyProject = undefined) {
  const { parseManifest } = await loadFleet();
  const found = findManifests(root);
  if (found.length === 0) {
    throw new Error(
      "run this from a project root (no .operon/operon.yaml or .operon/projects/*/operon.yaml here)"
    );
  }
  const manifests = found.map(({ path, directoryName }) => ({
    path,
    manifest: parseManifest(readFileSync(path, "utf8"), { directoryName })
  }));
  const selected =
    onlyProject === undefined
      ? manifests
      : manifests.filter(({ manifest }) => manifest.project === onlyProject);
  if (selected.length === 0) throw new Error(`no project named "${onlyProject}" here`);
  if (selected.length > 1) {
    throw new Error(
      `several projects here (${selected.map(({ manifest }) => manifest.project).join(", ")}); ` +
        "name one with --project"
    );
  }
  const { manifest, path: manifestPath } = selected[0];
  return {
    manifest,
    /** The file this manifest was read from: what a tool writes back into, never a guessed location. */
    manifestPath,
    /** Every project in the repo, for the tools that must see across projects. */
    all: manifests.map(entry => entry.manifest),
    /**
     * The project whose control plane enrolls this one (spec 0006 §9),
     * or undefined: it holds the WAKE_TRIGGER_TOKEN_<PROJECT> copy that
     * a wake-trigger rotation must write too.
     */
    host: manifests
      .map(entry => entry.manifest)
      .find(other => other.project !== manifest.project && (other.control?.enrolled ?? []).some(e => e.project === manifest.project)),
    /** "gatekeeper-x" -> the deployed Worker name for this project. */
    workerName: key => `${manifest.workerPrefix}-${key}`,
    /** The ops gateway's own hostname, as the templates route it. */
    opsUrl: `https://ops.${manifest.roster.zone}`,
    agentIds: manifest.roster.agents.map(agent => agent.id)
  };
}
