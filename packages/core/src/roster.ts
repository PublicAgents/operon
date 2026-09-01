/**
 * The roster is the deployment's list of tenants. It arrives as JSON (the
 * deployment repo's roster.jsonc with comments stripped, or a plain JSON
 * string in a Worker var) and is validated loudly: a roster that fails
 * validation names the agent and field that failed, because a silently
 * skipped agent is an agent that never wakes again.
 */

export interface RosterAgent {
  /** Stable slug, [a-z0-9-]; the agent's self-chosen name is cosmetic on top. */
  id: string;
  /** Private state repository, "owner/repo". */
  stateRepo: string;
  /** Cron expression; must also be registered as a trigger in the deployment. */
  cadence: string;
  /** Harness adapter id, e.g. "claude-code" or "codex". */
  harness: string;
  /** Pinned model for the mind. */
  model: string;
  /** Model to fall back to; a degraded wake beats a missed wake. */
  fallbackModel?: string;
  /**
   * Hard wall for one wake, minutes (default 120). A wake past it is
   * stopped and its unpushed work is lost, so size generously: this is a
   * hung-session backstop, not a productivity budget. Keep it under the
   * agent's cadence gap.
   */
  maxWakeMinutes?: number;
  /** Zone hosts this agent may publish to: "@" for the apex, otherwise subdomain labels. */
  hosts: string[];
  /**
   * The web door (spec 0004): a real browser, opt-in per agent. It is
   * opt-in because it changes the container's shape: a web-capable
   * agent launches with the deny-by-default `allowedHosts` egress fence
   * in force for the whole wake, so an extracted browser credential has
   * no direct path out. Default false: non-web agents launch exactly as
   * before.
   */
  web?: boolean;
  enabled: boolean;
}

export interface Roster {
  /** The colony zone, e.g. "example-colony.com". */
  zone: string;
  agents: RosterAgent[];
}

export class RosterError extends Error {
  override name = "RosterError";
}

const AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;
const STATE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HOST = /^(@|[a-z0-9]([a-z0-9-]*[a-z0-9])?)$/;
const ZONE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function fail(path: string, problem: string): never {
  throw new RosterError(`roster: ${path} ${problem}`);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "must be a non-empty string");
  }
  return value;
}

const AGENT_KEYS = new Set([
  "id",
  "stateRepo",
  "cadence",
  "harness",
  "model",
  "fallbackModel",
  "maxWakeMinutes",
  "hosts",
  "web",
  "enabled"
]);

function parseAgent(value: unknown, index: number): RosterAgent {
  const path = `agents[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const raw = value as Record<string, unknown>;

  // Unknown keys refuse rather than vanish: a misspelled field is a
  // grant or a policy the operator BELIEVES is in force, and silently
  // dropping it is how "this agent may not X" quietly becomes "may X".
  for (const key of Object.keys(raw)) {
    if (!AGENT_KEYS.has(key)) {
      fail(`${path}.${key}`, `is not a roster field (known: ${[...AGENT_KEYS].join(", ")})`);
    }
  }

  const id = requireString(raw.id, `${path}.id`);
  if (!AGENT_ID.test(id)) fail(`${path}.id`, `"${id}" is not a valid slug`);

  const stateRepo = requireString(raw.stateRepo, `${path}.stateRepo`);
  if (!STATE_REPO.test(stateRepo)) {
    fail(`${path}.stateRepo`, `"${stateRepo}" is not "owner/repo"`);
  }

  const cadence = requireString(raw.cadence, `${path}.cadence`);
  const harness = requireString(raw.harness, `${path}.harness`);
  const model = requireString(raw.model, `${path}.model`);

  let fallbackModel: string | undefined;
  if (raw.fallbackModel !== undefined) {
    fallbackModel = requireString(raw.fallbackModel, `${path}.fallbackModel`);
  }

  let maxWakeMinutes: number | undefined;
  if (raw.maxWakeMinutes !== undefined) {
    if (
      typeof raw.maxWakeMinutes !== "number" ||
      !Number.isInteger(raw.maxWakeMinutes) ||
      raw.maxWakeMinutes < 1
    ) {
      fail(`${path}.maxWakeMinutes`, "must be a positive integer (minutes)");
    }
    maxWakeMinutes = raw.maxWakeMinutes;
  }

  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0) {
    fail(`${path}.hosts`, "must be a non-empty array");
  }
  const hosts = raw.hosts.map((host, hostIndex) => {
    const value = requireString(host, `${path}.hosts[${hostIndex}]`);
    if (!HOST.test(value)) {
      fail(`${path}.hosts[${hostIndex}]`, `"${value}" is not "@" or a subdomain label`);
    }
    return value;
  });

  if (typeof raw.enabled !== "boolean") {
    fail(`${path}.enabled`, "must be a boolean");
  }

  if (raw.web !== undefined && typeof raw.web !== "boolean") {
    fail(`${path}.web`, "must be a boolean when present");
  }

  return {
    id,
    stateRepo,
    cadence,
    harness,
    model,
    fallbackModel,
    maxWakeMinutes,
    hosts,
    ...(raw.web === true ? { web: true } : {}),
    enabled: raw.enabled
  };
}

export function parseRoster(json: string): Roster {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new RosterError(`roster: not valid JSON (${(error as Error).message})`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("root", "must be an object");
  }
  const raw = value as Record<string, unknown>;

  const zone = requireString(raw.zone, "zone");
  if (!ZONE.test(zone)) fail("zone", `"${zone}" is not a registrable domain`);

  if (!Array.isArray(raw.agents)) fail("agents", "must be an array");
  const agents = raw.agents.map(parseAgent);

  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.id)) fail(`agents`, `duplicate agent id "${agent.id}"`);
    seen.add(agent.id);
  }

  return { zone, agents };
}

export function findAgent(roster: Roster, agentId: string): RosterAgent | undefined {
  return roster.agents.find(agent => agent.id === agentId);
}
