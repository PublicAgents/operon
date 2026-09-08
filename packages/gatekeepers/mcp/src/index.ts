import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { findAgent, parseRoster, type McpBudget, type McpServerDef } from "@operon/core";
import { errorResponse, json, Ledger, OpsEntrypoint, readJson } from "@operon/worker-kit";
import { inPortalScope, ownerOf, type ServerTrust, type UpstreamTool } from "./classify.js";
import { UpstreamError } from "./guarded-fetch.js";
import { CatalogMemory } from "./catalog-memory.js";
import { createProxyServer, type MeterRefusal } from "./proxy.js";
import { Meter } from "./meter-do.js";
import type { Remaining } from "./meter.js";
import {
  callUpstreamTool,
  catalogRevision,
  listUpstreamTools,
  withUpstream,
  type UpstreamConfig
} from "./upstream.js";

export { Ledger, Meter };
// Re-exports name functions and classes ONLY: a Worker entry module's
// export map may carry nothing else (workerd refuses a bare constant
// there), and the constants have their own modules to import from.
export { classify, inPortalScope, isRead, ownerOf } from "./classify.js";
export type { ServerTrust, ToolVerdict, UpstreamTool } from "./classify.js";
export { guardedFetch, UpstreamError } from "./guarded-fetch.js";
export type { GuardedFetchOptions } from "./guarded-fetch.js";
export * from "./upstream.js";
export { createProxyServer } from "./proxy.js";
export type { ProxyDeps, ProxyGrant } from "./proxy.js";

/**
 * The generic MCP Gatekeeper (spec 0008 §5): one Worker fronting every
 * REMOTE MCP server a colony declares, so no upstream credential enters
 * a container and no agent reaches a server it was not granted.
 *
 * Portal-first. A `type: portal` server lives behind the deployment's
 * Cloudflare MCP portal, where Cloudflare One holds the upstream
 * credential (OAuth included) and an administrator decided the server
 * belongs there. That decision is what makes such an upstream VETTED,
 * which is the only condition under which a server's own read-only
 * annotation authorizes anything. A `type: http` server is BYO: its
 * bearer is a secret here, and only tools the operator pinned by name
 * are callable.
 *
 * Reached only through the umbilical, which has already checked that
 * THIS agent was granted THIS server; identity rides x-operon-agent.
 */

interface Env {
  ROSTER: string;
  MCP_PORTAL_URL?: string;
  MCP_PORTAL_CLIENT_ID?: string;
  MCP_PORTAL_CLIENT_SECRET?: string;
  LEDGER: DurableObjectNamespace<Ledger>;
  METER: DurableObjectNamespace<Meter>;
  CHRONICLE?: D1Database;
  [secret: string]: unknown;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("mcp"));
}

function meter(env: Env, server: string) {
  return env.METER.get(env.METER.idFromName(server));
}

/** The price of one call under a budget: a number, 0 for a free read, undefined when the tool is neither. */
export function priceOf(budget: McpBudget, tool: string): number | undefined {
  if (budget.free?.includes(tool)) return 0;
  return Object.hasOwn(budget.perCall, tool) ? budget.perCall[tool] : undefined;
}

/** Every budgeted server of the roster with its meter's figures (spec 0014 §4). */
async function budgets(env: Env, at: string): Promise<Array<{ server: string; budget: McpBudget; remaining: Remaining }>> {
  const roster = parseRoster(env.ROSTER);
  const out: Array<{ server: string; budget: McpBudget; remaining: Remaining }> = [];
  for (const [name, def] of Object.entries(roster.mcp ?? {})) {
    const budget = (def as { budget?: McpBudget }).budget;
    if (!budget) continue;
    const { remaining, staleSettled } = await meter(env, name).remaining(budget.monthlyUsd, at);
    for (const stale of staleSettled) {
      await ledger(env).append("mcp_reservation_settled_stale", { agentId: stale.agentId, server: name, tool: stale.tool, usd: stale.usd });
    }
    out.push({ server: name, budget, remaining });
  }
  return out;
}

/** The operator's binding-only view of this ledger (spec 0003 step 3) and the budgets (spec 0014 §4). */
export class Ops extends OpsEntrypoint<Env> {
  protected async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/gatekeeper/mcp/ledger") {
      return json(await ledger(this.env).recent());
    }
    if (path === "/gatekeeper/mcp/budgets") {
      return json({ ok: true, budgets: await budgets(this.env, new Date().toISOString()) });
    }
    if (path === "/gatekeeper/mcp/budget-reset" && request.method === "POST") {
      const body = await readJson<{ server?: string; spentMonthUsd?: number }>(request);
      if (!body.ok || typeof body.value.server !== "string") return errorResponse(400, "malformed_json");
      const roster = parseRoster(this.env.ROSTER);
      const budget = (roster.mcp?.[body.value.server] as { budget?: McpBudget } | undefined)?.budget;
      if (!budget) return errorResponse(404, "mcp_not_budgeted", `"${body.value.server}" carries no budget`);
      const spent = typeof body.value.spentMonthUsd === "number" && body.value.spentMonthUsd >= 0 ? body.value.spentMonthUsd : 0;
      const remaining = await meter(this.env, body.value.server).reset(spent, budget.monthlyUsd, new Date().toISOString());
      await ledger(this.env).append("mcp_budget_reset", { server: body.value.server, spentMonthUsd: spent });
      return json({ ok: true, server: body.value.server, remaining });
    }
    return errorResponse(404, "not_found");
  }
}

/** "linear" -> MCP_LINEAR_TOKEN: the bearer for one byo server. */
export function bearerVar(name: string): string {
  return `MCP_${name.toUpperCase().replace(/-/g, "_")}_TOKEN`;
}

export interface ResolvedServer {
  name: string;
  def: McpServerDef;
  trust: ServerTrust;
  pinned: string[];
  upstream: UpstreamConfig;
  /** Set for a portal server: the one upstream this grant covers. */
  portalServer?: string;
}

export class ConfigRefusal extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ConfigRefusal";
  }
}

/**
 * Turn a granted server name into everything needed to reach it. The
 * agent's grant was already checked at the umbilical; this resolves
 * WHAT that grant points at, and refuses when the deployment has not
 * been configured for it.
 */
export function resolveServer(env: Env, agentId: string, name: string): ResolvedServer {
  const roster = parseRoster(env.ROSTER);
  const agent = findAgent(roster, agentId);
  if (!agent?.mcp?.includes(name)) {
    throw new ConfigRefusal("mcp_not_granted", `${agentId} was not granted "${name}"`);
  }
  const def = roster.mcp?.[name];
  if (!def) throw new ConfigRefusal("mcp_not_granted", `no server named "${name}"`);

  if (def.type === "portal") {
    const url = (env.MCP_PORTAL_URL ?? "").trim();
    if (!url || !env.MCP_PORTAL_CLIENT_ID || !env.MCP_PORTAL_CLIENT_SECRET) {
      throw new ConfigRefusal(
        "mcp_portal_unconfigured",
        "this deployment has no MCP portal configured (MCP_PORTAL_URL + Access service token)"
      );
    }
    return {
      name,
      def,
      // An administrator put this upstream behind the portal, which is
      // the deployment's decision to trust it (spec 0008 §5).
      trust: "vetted",
      pinned: def.tools ?? [],
      portalServer: def.server,
      upstream: {
        url,
        accessClientId: env.MCP_PORTAL_CLIENT_ID,
        accessClientSecret: env.MCP_PORTAL_CLIENT_SECRET
      }
    };
  }
  if (def.type === "http") {
    const bearer = def.auth === "bearer" ? (env[bearerVar(name)] as string | undefined) : undefined;
    if (def.auth === "bearer" && !bearer) {
      throw new ConfigRefusal("mcp_upstream_auth", `${bearerVar(name)} is not configured`);
    }
    // BYO: nobody vetted this upstream, so its annotations authorize
    // nothing and only pinned tools are callable.
    return { name, def, trust: "byo", pinned: def.tools ?? [], upstream: { url: def.url, ...(bearer ? { bearer } : {}) } };
  }
  throw new ConfigRefusal("mcp_not_granted", `"${name}" is not a remote server`);
}

/** The tools this grant may see: portal grants cover ONE upstream. */
export function scopedTools(server: ResolvedServer, tools: UpstreamTool[]): UpstreamTool[] {
  if (!server.portalServer) return tools;
  const known = [...new Set(tools.map(tool => ownerOf(tool.name, allServerIds(tools)) ?? ""))].filter(
    Boolean
  );
  return tools.filter(tool => inPortalScope(tool.name, server.portalServer as string, known));
}

/** Server ids the portal itself reveals, from its tool-name prefixes. */
function allServerIds(tools: UpstreamTool[]): string[] {
  const ids = new Set<string>();
  for (const tool of tools) {
    const underscore = tool.name.indexOf("_");
    if (underscore > 0) ids.add(tool.name.slice(0, underscore));
    // A two-part id (foo_bar_create) is only discoverable as a longer
    // prefix; add every prefix so ownerOf's longest-match can see them.
    let next = tool.name.indexOf("_", underscore + 1);
    while (next > 0) {
      ids.add(tool.name.slice(0, next));
      next = tool.name.indexOf("_", next + 1);
    }
  }
  return [...ids];
}

/**
 * The meter's two hooks for one budgeted server (spec 0014 §2): reserve
 * the price before the call, or refuse by name before the network;
 * settle after an answer of any kind, refund only after a provably
 * unsent call.
 */
function meterHooks(env: Env, agentId: string, server: string, budget: McpBudget) {
  return {
    before: async (tool: string): Promise<{ token: string } | { refused: MeterRefusal }> => {
      const price = priceOf(budget, tool);
      if (price === undefined) {
        return { refused: { code: "mcp_tool_unpriced", detail: `"${tool}" is neither priced in perCall nor named free on ${server}` } };
      }
      if (price === 0) return { token: "" };
      const id = crypto.randomUUID();
      const outcome = await meter(env, server).reserve({ id, tool, agentId, usd: price, monthlyUsd: budget.monthlyUsd }, new Date().toISOString());
      for (const stale of outcome.staleSettled) {
        await ledger(env).append("mcp_reservation_settled_stale", { agentId: stale.agentId, server, tool: stale.tool, usd: stale.usd });
      }
      if (!outcome.ok) {
        await ledger(env).append("mcp_budget_exhausted", { agentId, server, tool, usd: price, remainingTodayUsd: outcome.remaining.remainingTodayUsd });
        return { refused: { code: outcome.code, detail: outcome.detail } };
      }
      await ledger(env).append("mcp_metered", { agentId, server, tool, usd: price, remainingTodayUsd: outcome.remaining.remainingTodayUsd });
      return { token: id };
    },
    after: async (token: string, outcome: "answered" | "unreachable"): Promise<void> => {
      if (token === "") return;
      if (outcome === "unreachable") await meter(env, server).refund(token);
      else await meter(env, server).settle(token);
    }
  };
}

/** Catalog revisions already ledgered, per isolate (see CatalogMemory). */
const catalogs = new CatalogMemory();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // /mcp/<name>: the umbilical rewrites nothing, so the server name
    // arrives in the path the container's config named.
    const match = /^\/mcp\/([a-z0-9][a-z0-9-]*)(\/budget)?$/.exec(url.pathname);
    if (!match) return errorResponse(404, "not_found");
    // GET /mcp/<name>/budget: the remaining figures for the calling
    // agent's granted server (spec 0014 §2), read at wake start and on
    // demand, so a mind plans against a number.
    if (match[2] !== undefined) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      const agentId = request.headers.get("x-operon-agent") ?? "unknown";
      let resolved: ResolvedServer;
      try {
        resolved = resolveServer(env, agentId, match[1]);
      } catch (error) {
        const code = error instanceof ConfigRefusal ? error.code : "mcp_not_granted";
        return errorResponse(code === "mcp_not_granted" ? 403 : 503, code, error instanceof Error ? error.message : String(error));
      }
      const budget = (resolved.def as { budget?: McpBudget }).budget;
      if (!budget) return json({ ok: true, server: resolved.name, budgeted: false });
      const { remaining, staleSettled } = await meter(env, resolved.name).remaining(budget.monthlyUsd, new Date().toISOString());
      for (const stale of staleSettled) {
        await ledger(env).append("mcp_reservation_settled_stale", { agentId: stale.agentId, server: resolved.name, tool: stale.tool, usd: stale.usd });
      }
      return json({ ok: true, server: resolved.name, budgeted: true, remaining, perCall: budget.perCall, free: budget.free ?? [] });
    }
    // Only a POST carries a JSON-RPC message. The mind's client also
    // opens a GET for the server-to-client stream, and on this
    // stateless transport that is a 405 by design; it retries about
    // once a second for the whole wake. Answered here, before any
    // upstream handshake or ledger row: the first live wake ran 312
    // upstream handshakes and wrote 335 catalog rows for those GETs.
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
    }
    const name = match[1];
    const agentId = request.headers.get("x-operon-agent") ?? "unknown";

    let server: ResolvedServer;
    try {
      server = resolveServer(env, agentId, name);
    } catch (error) {
      const code = error instanceof ConfigRefusal ? error.code : "mcp_not_granted";
      const detail = error instanceof Error ? error.message : String(error);
      await ledger(env).append("mcp_refused", { agentId, server: name, code, detail });
      return errorResponse(code === "mcp_not_granted" ? 403 : 503, code, detail);
    }

    try {
      return await withUpstream(server.upstream, {}, async client => {
        const all = await listUpstreamTools(client);
        const tools = scopedTools(server, all);
        const revision = await catalogRevision(tools);
        // A catalog row records a CHANGE of what the mind is offered,
        // not a sighting: one row per request was one per second. The
        // revision is noted only once its row is written, so a failed
        // append is retried by the next request rather than forgotten.
        await catalogs.record(agentId, server.name, revision, () =>
          ledger(env).append("mcp_catalog", {
            agentId,
            server: server.name,
            revision,
            tools: tools.length
          })
        );
        const budget = (server.def as { budget?: McpBudget }).budget;
        const proxy = await createProxyServer(server, {
          tools,
          call: (toolName, args) => callUpstreamTool(client, toolName, args),
          record: (event, detail) => ledger(env).append(event, { agentId, ...detail }),
          ...(budget ? meterHooks(env, agentId, server.name, budget) : {})
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true
        });
        await proxy.connect(transport);
        try {
          return await transport.handleRequest(request);
        } finally {
          await proxy.close();
        }
      });
    } catch (error) {
      const code = error instanceof UpstreamError ? error.code : "mcp_upstream_unreachable";
      const detail = error instanceof Error ? error.message : String(error);
      await ledger(env).append("mcp_upstream_failed", { agentId, server: server.name, code, detail });
      return errorResponse(502, code, detail);
    }
  }
} satisfies ExportedHandler<Env>;
