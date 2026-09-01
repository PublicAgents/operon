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
  /** Names of colony-level mcp servers granted to this agent (spec 0008). */
  mcp?: string[];
  /** Per-agent GitHub grants (spec 0008 §6). */
  github?: GithubGrants;
}

export interface Roster {
  /** The colony zone, e.g. "example-colony.com". */
  zone: string;
  agents: RosterAgent[];
  /** Colony-level MCP server definitions (spec 0008 §3); agents reference them by name. */
  mcp?: Record<string, McpServerDef>;
}

/**
 * One MCP server an agent may be granted (spec 0008). The four shapes
 * share a doctrine: a credential lives in a Worker or in Cloudflare
 * One, never in the container, and a stdio definition has no place to
 * put one at all.
 */
export type McpServerDef =
  | {
      /** A bespoke operon Worker speaking MCP (e.g. gatekeeper-google-analytics). */
      type: "gatekeeper";
      worker: string;
    }
  | {
      /** An upstream behind the deployment's Cloudflare MCP portal. */
      type: "portal";
      server: string;
      /** Write pins; reads pass via the vetted tier. */
      tools?: string[];
    }
  | {
      /** A plain remote server; bearer secret (MCP_<NAME>_TOKEN) lives on gatekeeper-mcp. */
      type: "http";
      url: string;
      auth: "none" | "bearer";
      /** byo tier: ONLY pinned tools are callable. */
      tools?: string[];
    }
  | {
      /** In-container, credential-less by construction: no env field exists. */
      type: "stdio";
      command: string;
      args: string[];
    };

/** Per-agent GitHub grants (spec 0008 §6). Absent lists grant nothing. */
export interface GithubGrants {
  /** Repos this agent may open fork PRs / issues against and watch. */
  pr?: string[];
  /** Repos where the agent may commit to NON-default branches via the App. */
  write?: string[];
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
  "enabled",
  "mcp",
  "github"
]);

/** MCP server names are slugs, and so are portal server ids (underscores allowed there). */
const MCP_NAME = /^[a-z0-9][a-z0-9-]*$/;
const PORTAL_SERVER = /^[a-z0-9][a-z0-9_-]*$/;

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value.map((entry, i) => requireString(entry, `${path}[${i}]`));
}

/** The keys allowed per def type: an unknown key refuses, it never vanishes. */
const MCP_DEF_KEYS: Record<string, Set<string>> = {
  gatekeeper: new Set(["type", "worker"]),
  portal: new Set(["type", "server", "tools"]),
  http: new Set(["type", "url", "auth", "tools"]),
  stdio: new Set(["type", "command", "args"])
};

function parseMcpDef(name: string, value: unknown): McpServerDef {
  const path = `mcp.${name}`;
  if (!MCP_NAME.test(name)) fail(path, `"${name}" is not a valid server name (slug)`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const raw = value as Record<string, unknown>;
  const type = requireString(raw.type, `${path}.type`);
  const known = MCP_DEF_KEYS[type];
  if (!known) fail(`${path}.type`, `must be one of ${Object.keys(MCP_DEF_KEYS).join(", ")}`);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      // Named for the one likely mistake: stdio is credential-less by
      // construction, so env has no place to exist (spec 0008 §4).
      if (type === "stdio" && key === "env") {
        fail(`${path}.env`, "stdio_env_unsupported: stdio servers carry no env; a value that needs one belongs behind a gatekeeper or the portal");
      }
      fail(`${path}.${key}`, `is not a ${type} server field (known: ${[...known].join(", ")})`);
    }
  }
  const tools =
    raw.tools === undefined
      ? undefined
      : requireStringArray(raw.tools, `${path}.tools`).map(tool => {
          if (tool.length === 0) fail(`${path}.tools`, "must not contain empty names");
          if (tool.startsWith("portal_")) {
            fail(`${path}.tools`, `"${tool}" is never grantable: portal_* tools change which servers a session reaches`);
          }
          return tool;
        });
  switch (type) {
    case "gatekeeper": {
      const worker = requireString(raw.worker, `${path}.worker`);
      if (!/^gatekeeper-[a-z0-9-]+$/.test(worker)) {
        fail(`${path}.worker`, `"${worker}" is not a gatekeeper worker key`);
      }
      return { type, worker };
    }
    case "portal": {
      const server = requireString(raw.server, `${path}.server`);
      if (!PORTAL_SERVER.test(server)) fail(`${path}.server`, `"${server}" is not a server id`);
      return { type, server, ...(tools ? { tools } : {}) };
    }
    case "http": {
      const url = requireString(raw.url, `${path}.url`);
      if (!/^https:\/\//.test(url)) fail(`${path}.url`, "must be an https:// URL");
      const auth = requireString(raw.auth, `${path}.auth`);
      if (auth !== "none" && auth !== "bearer") fail(`${path}.auth`, 'must be "none" or "bearer"');
      return { type, url, auth, ...(tools ? { tools } : {}) };
    }
    default: {
      const command = requireString(raw.command, `${path}.command`);
      const args = requireStringArray(raw.args, `${path}.args`);
      // The pin rule, mechanically: an unpinned or range-pinned package
      // is whatever the registry serves that morning. Some arg must name
      // an EXACT version (npm's pkg@1.2.3 or pip's pkg==1.2.3), and no
      // arg may carry a range or a floating tag.
      const EXACT_PIN = /(@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|==\d+(?:\.\d+)*)$/;
      const FLOATING = /@(?:latest$|next$|[\^~><=*])|(^|[^=])=\d[^=]*\*/;
      for (const arg of args) {
        if (FLOATING.test(arg)) {
          fail(`${path}.args`, `"${arg}" is a range or floating tag; name an exact version`);
        }
      }
      if (!args.some(arg => EXACT_PIN.test(arg))) {
        fail(`${path}.args`, `no exact version pin found; name one (pkg@1.2.3 or pkg==1.2.3)`);
      }
      return { type: "stdio", command, args };
    }
  }
}

function parseMcpDefs(value: unknown): Record<string, McpServerDef> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("mcp", "must be an object of server definitions");
  }
  const defs: Record<string, McpServerDef> = {};
  for (const [name, def] of Object.entries(value as Record<string, unknown>)) {
    defs[name] = parseMcpDef(name, def);
  }
  // Portal prefix grammars are ambiguous when one server id prefixes
  // another (spec 0008 §5): refuse at validation, not at call time.
  const portalIds = Object.values(defs)
    .filter(def => def.type === "portal")
    .map(def => (def as { server: string }).server);
  for (const a of portalIds) {
    for (const b of portalIds) {
      if (a !== b && b.startsWith(`${a}_`)) {
        fail("mcp", `portal_server_ambiguous: server id "${a}" prefixes "${b}"`);
      }
    }
  }
  return defs;
}

const GITHUB_GRANT_KEYS = new Set(["pr", "write"]);

function parseGithubGrants(value: unknown, path: string): GithubGrants {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!GITHUB_GRANT_KEYS.has(key)) {
      fail(`${path}.${key}`, `is not a github grant (known: ${[...GITHUB_GRANT_KEYS].join(", ")})`);
    }
  }
  const repos = (key: "pr" | "write"): string[] | undefined => {
    if (raw[key] === undefined) return undefined;
    return requireStringArray(raw[key], `${path}.${key}`).map((repo, i) => {
      if (!STATE_REPO.test(repo)) fail(`${path}.${key}[${i}]`, `"${repo}" is not "owner/repo"`);
      return repo;
    });
  };
  const pr = repos("pr");
  const write = repos("write");
  return { ...(pr ? { pr } : {}), ...(write ? { write } : {}) };
}

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

  let mcp: string[] | undefined;
  if (raw.mcp !== undefined) {
    mcp = requireStringArray(raw.mcp, `${path}.mcp`);
  }

  let github: GithubGrants | undefined;
  if (raw.github !== undefined) {
    github = parseGithubGrants(raw.github, `${path}.github`);
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
    enabled: raw.enabled,
    ...(mcp ? { mcp } : {}),
    ...(github ? { github } : {})
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

  const mcp = raw.mcp === undefined ? undefined : parseMcpDefs(raw.mcp);
  // An agent's grant list may only name defined servers: a dangling
  // name is a capability the operator believes exists.
  for (const [index, agent] of agents.entries()) {
    for (const name of agent.mcp ?? []) {
      if (!mcp || !(name in mcp)) {
        fail(`agents[${index}].mcp`, `"${name}" names no server in the mcp: section`);
      }
    }
  }

  return { zone, agents, ...(mcp ? { mcp } : {}) };
}

export function findAgent(roster: Roster, agentId: string): RosterAgent | undefined {
  return roster.agents.find(agent => agent.id === agentId);
}
