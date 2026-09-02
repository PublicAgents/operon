import { ToolInputError, type FleetInfo, type FleetProject } from "@operon/ops-tools";

/**
 * The fleet this plane reaches (spec 0006 §9): the host project it is
 * deployed beside, under bare binding names as before, and the
 * enrolled projects rendered into `<PROJECT>__<BINDING>` service
 * bindings by the fleet templates. Pure, so the resolution rules are
 * testable without a Worker.
 */

export interface FleetEnv {
  HOST_PROJECT?: string;
  HOST_ZONE?: string;
  DEFAULT_PROJECT?: string;
  /** JSON array of { project, zone, workerPrefix } for every enrolled project but the host. */
  PROJECTS?: string;
  /** The host's worker prefix, with its trailing dash. */
  WORKER_NAME_PREFIX?: string;
}

/** "second-project" -> SECOND_PROJECT, the binding and secret infix (mirrors the templates). */
export function projectVar(project: string): string {
  return project.toUpperCase().replace(/-/g, "_");
}

export function fleetOf(env: FleetEnv): FleetInfo {
  const host = env.HOST_PROJECT ?? "default";
  const hostPrefix = (env.WORKER_NAME_PREFIX ?? "operon-").replace(/-$/, "");
  let enrolled: FleetProject[] = [];
  if (env.PROJECTS) {
    try {
      const parsed = JSON.parse(env.PROJECTS) as unknown;
      enrolled = (Array.isArray(parsed) ? parsed : [])
        .filter(
          (entry): entry is FleetProject =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as FleetProject).project === "string" &&
            typeof (entry as FleetProject).workerPrefix === "string"
        )
        .map(entry => ({ project: entry.project, zone: entry.zone, workerPrefix: entry.workerPrefix }));
    } catch {
      // A malformed var enrolls nothing rather than something partial;
      // the host itself always resolves.
      enrolled = [];
    }
  }
  return {
    host,
    defaultProject: env.DEFAULT_PROJECT ?? host,
    projects: [
      { project: host, ...(env.HOST_ZONE ? { zone: env.HOST_ZONE } : {}), workerPrefix: hostPrefix },
      ...enrolled
    ]
  };
}

/**
 * The project a call acts on: the one it names, else the default. An
 * unknown name is a named refusal, never a fallback to the default.
 */
export function resolveProject(fleet: FleetInfo, requested: string | undefined): FleetProject {
  const name = requested ?? fleet.defaultProject;
  const found = fleet.projects.find(candidate => candidate.project === name);
  if (!found) {
    const enrolled = fleet.projects.map(candidate => candidate.project);
    throw new ToolInputError(`unknown project: ${name} (enrolled: ${enrolled.join(", ")})`, 404, {
      error: "unknown_project",
      project: name,
      enrolled
    });
  }
  return found;
}

/** The binding a project's gatekeeper is wired under on this plane. */
export function bindingFor(fleet: FleetInfo, project: FleetProject, binding: string): string {
  return project.project === fleet.host ? binding : `${projectVar(project.project)}__${binding}`;
}

/** The wake-trigger bearer's name for a project: the host's under its old name. */
export function wakeTokenVar(fleet: FleetInfo, project: FleetProject): string {
  return project.project === fleet.host
    ? "WAKE_TRIGGER_TOKEN"
    : `WAKE_TRIGGER_TOKEN_${projectVar(project.project)}`;
}
