/**
 * The umbilical's pure routing (spec 0003 step 4), runtime-free so it is
 * unit-tested without the Workers runtime. The entrypoint in umbilical.ts
 * wraps it.
 */
import { findAgent, parseRoster, type McpServerDef } from "@operon/core";

interface DoorRoute {
  binding: string;
  /** Shared bearer env name, or the per-agent bearer prefix. */
  bearerEnv?: string;
  perAgentPrefix?: string;
  /** Binding-only door: no bearer exists or is attached; the private
   * service binding IS the auth (the target worker has no public
   * surface) and identity rides x-operon-agent. */
  bearerless?: boolean;
}

/** virtual host label -> Gatekeeper binding + which bearer to attach. */
export const DOOR_ROUTES: Record<string, DoorRoute> = {
  notify: { binding: "TELEGRAM", bearerEnv: "NOTIFY_TOKEN" },
  email: { binding: "EMAIL", bearerEnv: "EMAIL_TOKEN" },
  publish: { binding: "DEPLOY", bearerEnv: "PUBLISH_TOKEN" },
  persist: { binding: "GITHUB", bearerEnv: "PERSIST_TOKEN" },
  pr: { binding: "PR", bearerEnv: "PR_TOKEN" },
  chronicle: { binding: "CHRONICLE", bearerEnv: "CHRONICLE_TOKEN" },
  till: { binding: "TILL", perAgentPrefix: "TILL_TOKEN" },
  spend: { binding: "SPEND", perAgentPrefix: "SPEND_TOKEN" },
  vault: { binding: "VAULT", perAgentPrefix: "VAULT_TOKEN" },
  x: { binding: "X", perAgentPrefix: "X_TOKEN" },
  asks: { binding: "ASKS_GK", perAgentPrefix: "ASKS_TOKEN" },
  // The web door (spec 0004): browser-gk has no public surface, so the
  // binding is the auth and no bearer rides at all.
  web: { binding: "BROWSER", bearerless: true }
};

export const INTERNAL_SUFFIX = ".operon.internal";

/** MCP servers get their own host space: mcp-<name>.operon.internal. */
const MCP_PREFIX = "mcp-";

/**
 * The binding that fronts one MCP server (spec 0008 §4): a bespoke
 * Worker for a `gatekeeper` def, and the generic proxy for everything
 * remote. The name is derived, never taken from the request.
 */
function mcpBinding(def: McpServerDef): string {
  return def.type === "gatekeeper"
    ? `MCP_${def.worker.replace(/^gatekeeper-/, "").toUpperCase().replace(/-/g, "_")}`
    : "MCP_GK";
}

/**
 * Which MCP servers this agent may reach, as virtual hosts. The
 * WakeContainer intercepts exactly these, so an ungranted server is
 * unreachable twice over: unintercepted here, and refused by
 * resolveDoor if it somehow arrives anyway.
 */
export function mcpHostsFor(rosterJson: string | undefined, agentId: string): string[] {
  const granted = grantedServers(rosterJson, agentId);
  return [...granted.keys()].map(name => `${MCP_PREFIX}${name}${INTERNAL_SUFFIX}`);
}

/** The agent's granted server definitions, by name; empty on any doubt. */
function grantedServers(
  rosterJson: string | undefined,
  agentId: string
): Map<string, McpServerDef> {
  const out = new Map<string, McpServerDef>();
  if (typeof rosterJson !== "string" || rosterJson.length === 0) return out;
  try {
    const roster = parseRoster(rosterJson);
    const agent = findAgent(roster, agentId);
    for (const name of agent?.mcp ?? []) {
      const def = roster.mcp?.[name];
      if (def) out.set(name, def);
    }
  } catch {
    // An unparseable roster grants nothing: unlike a repo allowlist,
    // there is no narrower previous behaviour to fall back to.
  }
  return out;
}

/** The virtual host for a door, e.g. "email" -> "email.operon.internal". */
export function doorHost(door: string): string {
  return `${door}${INTERNAL_SUFFIX}`;
}

/** All door virtual hosts (for the WakeContainer to intercept). */
export function allDoorHosts(): string[] {
  return Object.keys(DOOR_ROUTES).map(doorHost);
}

/** "promoter" -> "TILL_TOKEN_PROMOTER". */
function perAgentVar(prefix: string, agentId: string): string {
  return `${prefix}_${agentId.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * The policy door (spec 0006 §7) a request to a virtual host falls
 * under, or null for plumbing (persist's commit, chronicle). The doors
 * matrix withholds a closed door's URL from the container, but the
 * nonce is one per wake and the hosts are guessable, so withholding is
 * not enforcement: the router refuses here, outside the container.
 * The GitHub door covers the pr host AND the branch route on the
 * persist host, which is a content write the door governs; the commit
 * route stays open because a wake without its state commit loses its
 * work.
 */
export function policyDoorFor(hostname: string, pathname: string): string | null {
  if (!hostname.endsWith(INTERNAL_SUFFIX)) return null;
  const label = hostname.slice(0, -INTERNAL_SUFFIX.length);
  if (label.startsWith(MCP_PREFIX)) return "mcp";
  switch (label) {
    case "notify":
    case "email":
    case "publish":
    case "till":
    case "vault":
    case "x":
    case "asks":
    case "web":
      return label;
    case "spend":
      return "pay";
    case "pr":
      return "github";
    case "persist":
      return pathname === "/branch" || pathname.startsWith("/branch/") ? "github" : null;
    default:
      return null;
  }
}

/** Pure resolution (unit-tested): the binding + real bearer for a request. */
export function resolveDoor(
  hostname: string,
  env: Record<string, unknown>,
  agentId: string
): { binding: string; bearer?: string } | { error: string } {
  if (!hostname.endsWith(INTERNAL_SUFFIX)) return { error: "not_internal" };
  const door = hostname.slice(0, -INTERNAL_SUFFIX.length);
  // MCP servers (spec 0008 §4): the grant is checked HERE, outside the
  // container, before any binding is touched. The container carries a
  // name; whether that name is granted is the supervisor's fact.
  if (door.startsWith(MCP_PREFIX)) {
    const name = door.slice(MCP_PREFIX.length);
    const def = grantedServers(env.ROSTER as string | undefined, agentId).get(name);
    if (!def) return { error: "mcp_not_granted" };
    // Identity rides x-operon-agent, as the web door does: the target
    // Worker is private and the binding is the authorization.
    return { binding: mcpBinding(def) };
  }
  const route = DOOR_ROUTES[door];
  if (!route) return { error: "unknown_door" };
  if (route.bearerless) return { binding: route.binding };
  const bearer = route.perAgentPrefix
    ? env[perAgentVar(route.perAgentPrefix, agentId)]
    : env[route.bearerEnv as string];
  if (typeof bearer !== "string" || bearer.length === 0) return { error: "bearer_unconfigured" };
  return { binding: route.binding, bearer };
}
