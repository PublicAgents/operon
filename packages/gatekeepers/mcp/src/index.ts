import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { findAgent, parseRoster, type McpBudget, type McpServerDef, type McpWebhook } from "@operon/core";
import { errorResponse, json, Ledger, OpsEntrypoint, readJson } from "@operon/worker-kit";
import { inPortalScope, ownerOf, type ServerTrust, type UpstreamTool } from "./classify.js";
import { UpstreamError } from "./guarded-fetch.js";
import { CatalogMemory } from "./catalog-memory.js";
import { createProxyServer, type MeterRefusal } from "./proxy.js";
import { Meter } from "./meter-do.js";
import type { Remaining } from "./meter.js";
import { Runs } from "./runs-do.js";
import type { UnattributedResult } from "./runs.js";
import { deliveryKey, fillRegistration, readPath, runIdFromResult, signedInput, timestampMs, TIMESTAMP_SKEW_MS, verifySignature } from "./hooks.js";
import {
  callUpstreamTool,
  catalogRevision,
  listUpstreamTools,
  withUpstream,
  type UpstreamConfig
} from "./upstream.js";

export { Ledger, Meter, Runs };
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
  RUNS: DurableObjectNamespace<Runs>;
  CHRONICLE?: D1Database;
  [secret: string]: unknown;
}

function ledger(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("mcp"));
}

function meter(env: Env, server: string) {
  return env.METER.get(env.METER.idFromName(server));
}

function runs(env: Env, server: string) {
  return env.RUNS.get(env.RUNS.idFromName(server));
}

/** "tasks" -> MCP_TASKS_WEBHOOK_SECRET: the provider's signing secret (or public key) for one server. */
export function webhookSecretVar(name: string): string {
  return `MCP_${name.toUpperCase().replace(/-/g, "_")}_WEBHOOK_SECRET`;
}

/** The public callback URL a provider is registered with (spec 0014 §3). */
export function callbackUrl(zone: string, server: string): string {
  return `https://hooks.${zone}/webhook/${server}`;
}

/**
 * A provider's callback on hooks.<zone> (spec 0014 §3): verified or
 * refused, read at the contract's paths, stored once per delivery,
 * queued for the run's agent or kept for the operator. Never a guess.
 */
async function handleWebhook(request: Request, env: Env, name: string): Promise<Response> {
  const roster = parseRoster(env.ROSTER);
  const def = roster.mcp?.[name] as { webhook?: McpWebhook } | undefined;
  const contract = def?.webhook;
  if (!contract) return errorResponse(404, "not_found");
  const secret = env[webhookSecretVar(name)];
  if (typeof secret !== "string" || secret.length === 0) {
    await ledger(env).append("mcp_webhook_unverified", { server: name, reason: "secret_unconfigured" });
    return errorResponse(503, "mcp_webhook_unverified", `${webhookSecretVar(name)} is not configured`);
  }
  const body = await request.text();
  const at = new Date().toISOString();
  const signature = request.headers.get(contract.signature.header) ?? "";
  const timestamp = contract.signature.timestampHeader ? (request.headers.get(contract.signature.timestampHeader) ?? undefined) : undefined;
  const deliveryId = contract.signature.idHeader ? (request.headers.get(contract.signature.idHeader) ?? undefined) : undefined;
  const source = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (contract.signature.timestampHeader) {
    const ms = timestamp === undefined ? undefined : timestampMs(timestamp);
    if (ms === undefined || Math.abs(Date.now() - ms) > TIMESTAMP_SKEW_MS) {
      await ledger(env).append("mcp_webhook_unverified", { server: name, reason: "timestamp", source });
      return errorResponse(401, "mcp_webhook_unverified", "the timestamp is missing, unreadable, or older than five minutes");
    }
  }
  if (contract.signature.idHeader && !deliveryId) {
    await ledger(env).append("mcp_webhook_unverified", { server: name, reason: "id_header", source });
    return errorResponse(401, "mcp_webhook_unverified", `the ${contract.signature.idHeader} header is missing`);
  }
  const verified =
    signature.length > 0 && (await verifySignature(contract.signature.scheme, secret, signature, signedInput(body, timestamp, deliveryId)));
  if (!verified) {
    await ledger(env).append("mcp_webhook_unverified", { server: name, reason: "signature", source });
    return errorResponse(401, "mcp_webhook_unverified", "the signature does not verify");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const runIdValue = readPath(parsed, contract.callbackRunIdPath);
  const eventValue = readPath(parsed, contract.callbackEventPath);
  const callbackId = contract.callbackIdPath ? readPath(parsed, contract.callbackIdPath) : undefined;
  const runId = typeof runIdValue === "string" ? runIdValue : typeof runIdValue === "number" ? String(runIdValue) : undefined;
  const event = typeof eventValue === "string" ? eventValue : undefined;
  const idMissing = contract.callbackIdPath !== undefined && callbackId === undefined;
  if (runId === undefined || event === undefined || idMissing) {
    // Kept for the operator under a run id of "?" rather than dropped:
    // the provider billed for something.
    const stored = await runs(env, name).storeCallback({
      runId: runId ?? "?",
      event: event ?? "?",
      // Never deduplicated against anything (spec 0014 §3): nothing
      // readable says what it repeats.
      deliveryKey: `unreadable:${crypto.randomUUID()}`,
      body,
      at
    });
    await ledger(env).append("mcp_webhook_unreadable", { server: name, paths: [contract.callbackRunIdPath, contract.callbackEventPath, contract.callbackIdPath].filter(Boolean), stored: stored.stored });
    return json({ ok: true, stored: stored.stored, attributed: false });
  }
  const stored = await runs(env, name).storeCallback({ runId, event, deliveryKey: await deliveryKey(callbackId, body), body, at });
  if (!stored.stored) return json({ ok: true, stored: false, repeat: true });
  if (stored.agentId) {
    await ledger(env).append("mcp_webhook_received", { agentId: stored.agentId, server: name, runId, event });
  } else {
    await ledger(env).append("mcp_webhook_unknown_run", { server: name, runId, event });
  }
  return json({ ok: true, stored: true, attributed: Boolean(stored.agentId) });
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

/** Every callback held for the operator (spec 0014 §3), per webhook-bearing server, with its evidence. */
async function unattributed(env: Env): Promise<Array<{ server: string; results: UnattributedResult[] }>> {
  const roster = parseRoster(env.ROSTER);
  const out: Array<{ server: string; results: UnattributedResult[] }> = [];
  for (const [name, def] of Object.entries(roster.mcp ?? {})) {
    if (!(def as { webhook?: unknown }).webhook) continue;
    const results = await runs(env, name).listUnattributed();
    if (results.length > 0) out.push({ server: name, results });
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
      return json({
        ok: true,
        budgets: await budgets(this.env, new Date().toISOString()),
        unattributed: await unattributed(this.env)
      });
    }
    if (path === "/gatekeeper/mcp/result-assign" && request.method === "POST") {
      const body = await readJson<{ server?: string; id?: string; agentId?: string }>(request);
      if (!body.ok || typeof body.value.server !== "string" || typeof body.value.id !== "string" || typeof body.value.agentId !== "string") {
        return errorResponse(400, "malformed_json");
      }
      const roster = parseRoster(this.env.ROSTER);
      if (!findAgent(roster, body.value.agentId)) return errorResponse(404, "unknown_agent");
      if (!(roster.mcp?.[body.value.server] as { webhook?: unknown } | undefined)?.webhook) return errorResponse(404, "not_found");
      const assigned = await runs(this.env, body.value.server).assign(body.value.id, body.value.agentId);
      if (!assigned) return errorResponse(404, "not_found", "no unattributed result with that id");
      await ledger(this.env).append("mcp_result_assigned", { agentId: body.value.agentId, server: body.value.server, runId: assigned.runId, id: assigned.id });
      return json({ ok: true, runId: assigned.runId, agentId: body.value.agentId });
    }
    if (path === "/gatekeeper/mcp/budget-reset" && request.method === "POST") {
      const body = await readJson<{ server?: string; spentMonthUsd?: number }>(request);
      if (!body.ok || typeof body.value.server !== "string") return errorResponse(400, "malformed_json");
      const roster = parseRoster(this.env.ROSTER);
      const budget = (roster.mcp?.[body.value.server] as { budget?: McpBudget } | undefined)?.budget;
      if (!budget) return errorResponse(404, "mcp_not_budgeted", `"${body.value.server}" carries no budget`);
      // The operator's figure is required and must be a real amount: a
      // reset that "forgot" the month's spend would hand out capacity.
      const spent = body.value.spentMonthUsd;
      if (typeof spent !== "number" || !Number.isFinite(spent) || spent < 0) {
        return errorResponse(400, "invalid_request", "spentMonthUsd must be a non-negative number, the vendor dashboard's month-to-date figure");
      }
      const { remaining, staleSettled } = await meter(this.env, body.value.server).reset(spent, budget.monthlyUsd, new Date().toISOString());
      // The reset is committed above; the rows after it are best effort
      // and their failure is reported beside the result, never as it.
      const unrecorded: string[] = [];
      for (const stale of staleSettled) {
        try {
          await ledger(this.env).append("mcp_reservation_settled_stale", { agentId: stale.agentId, server: body.value.server, tool: stale.tool, usd: stale.usd });
        } catch {
          unrecorded.push(`mcp_reservation_settled_stale ${stale.id}`);
        }
      }
      try {
        await ledger(this.env).append("mcp_budget_reset", { server: body.value.server, spentMonthUsd: spent, openReservationsUsd: remaining.openReservationsUsd });
      } catch {
        unrecorded.push("mcp_budget_reset");
      }
      return json({ ok: true, server: body.value.server, remaining, ...(unrecorded.length > 0 ? { unrecorded } : {}) });
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
 * The hooks around one call (spec 0014): the meter's reservation before
 * and settlement after, and the webhook contract's registration on a
 * create call and run attribution from its answer. Tokens carry both.
 */
function callHooks(env: Env, agentId: string, server: string, zone: string, budget: McpBudget | undefined, contract: McpWebhook | undefined) {
  const meterHook = budget ? meterHooks(env, agentId, server, budget) : undefined;
  return {
    before: async (tool: string, args: Record<string, unknown>) => {
      const gate = meterHook ? await meterHook.before(tool) : { token: "" };
      if ("refused" in gate) return gate;
      if (!contract || !contract.createTools.includes(tool)) return { token: `${gate.token}|` };
      // The registration is the Gatekeeper's: the mind never chooses the
      // URL; an open create remembers the agent until the run id comes back.
      const createId = crypto.randomUUID();
      await runs(env, server).openCreate({ id: createId, agentId, tool, at: new Date().toISOString() });
      const registration = fillRegistration(contract.registration, callbackUrl(zone, server), contract.events);
      return { token: `${gate.token}|${createId}`, args: { ...args, [contract.argument]: registration } };
    },
    after: async (token: string, result: unknown) => {
      const [meterToken, createId] = token.split("|");
      if (meterHook && meterToken) await meterHook.after(meterToken);
      if (!contract || !createId) return;
      const runId = result === undefined ? undefined : runIdFromResult(result, contract.runIdPath);
      if (runId) {
        await runs(env, server).closeCreate(createId, runId);
      } else {
        // The answer carried no id at the named path (or was lost): the
        // create stays open as the operator's evidence, and the row says so.
        await ledger(env).append("mcp_webhook_run_unattributed", { agentId, server, createId, path: contract.runIdPath, answered: result !== undefined });
      }
    }
  };
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
      // Rows written after the reservation are best effort: none of
      // them may leave a reservation open for a call that never goes.
      const bestEffort = async (event: string, detail: Record<string, unknown>) => {
        try {
          await ledger(env).append(event, detail);
        } catch (error) {
          console.error(`mcp ${event} could not be ledgered`, error);
        }
      };
      for (const stale of outcome.staleSettled) {
        await bestEffort("mcp_reservation_settled_stale", { agentId: stale.agentId, server, tool: stale.tool, usd: stale.usd });
      }
      if (!outcome.ok) {
        await bestEffort("mcp_budget_exhausted", { agentId, server, tool, usd: price, remainingTodayUsd: outcome.remaining.remainingTodayUsd });
        return { refused: { code: outcome.code, detail: outcome.detail } };
      }
      // The metered row is the audit of a spend that is about to happen
      // (spec 0003: the record before the privileged act). When it
      // cannot be written the call does not go, and this is the one
      // case where a refund is honest: nothing was sent.
      try {
        await ledger(env).append("mcp_metered", { agentId, server, tool, usd: price, remainingTodayUsd: outcome.remaining.remainingTodayUsd });
      } catch (error) {
        // The refund is best effort as well: if it fails, the stale
        // sweep settles the reservation (an overcount by one call, the
        // safe direction), and the refusal still says why.
        try {
          await meter(env, server).refund(id);
        } catch (refundError) {
          console.error("mcp reservation could not be refunded after an audit failure", refundError);
        }
        return { refused: { code: "mcp_audit_unavailable", detail: `the spend could not be recorded, so the call was not made: ${error instanceof Error ? error.message : String(error)}` } };
      }
      return { token: id };
    },
    after: async (token: string): Promise<void> => {
      if (token === "") return;
      await meter(env, server).settle(token);
    }
  };
}

/** Catalog revisions already ledgered, per isolate (see CatalogMemory). */
const catalogs = new CatalogMemory();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // hooks.<zone>: the one public surface of this Worker (spec 0014
    // §3), a provider's callback, verified before it is read.
    const hook = /^\/webhook\/([a-z0-9][a-z0-9-]*)$/.exec(url.pathname);
    if (hook) {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      return handleWebhook(request, env, hook[1]);
    }
    // /mcp/<name>: the umbilical rewrites nothing, so the server name
    // arrives in the path the container's config named.
    const match = /^\/mcp\/([a-z0-9][a-z0-9-]*)(\/budget|\/results|\/results\/ack)?$/.exec(url.pathname);
    if (!match) return errorResponse(404, "not_found");
    // The agent's queued results (spec 0014 §3): pulled at wake start,
    // acked by the wake after its persist.
    if (match[2] === "/results" || match[2] === "/results/ack") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      const agentId = request.headers.get("x-operon-agent") ?? "unknown";
      let resolved: ResolvedServer;
      try {
        resolved = resolveServer(env, agentId, match[1]);
      } catch (error) {
        const code = error instanceof ConfigRefusal ? error.code : "mcp_not_granted";
        return errorResponse(code === "mcp_not_granted" ? 403 : 503, code, error instanceof Error ? error.message : String(error));
      }
      if (!(resolved.def as { webhook?: unknown }).webhook) return json({ ok: true, results: [] });
      if (match[2] === "/results") return json({ ok: true, results: await runs(env, resolved.name).pullResults(agentId) });
      const body = await readJson<{ ids?: string[] }>(request);
      const ids = body.ok && Array.isArray(body.value.ids) ? body.value.ids.filter(id => typeof id === "string") : [];
      return json({ ok: true, acked: await runs(env, resolved.name).ackResults(agentId, ids) });
    }
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
        const contract = (server.def as { webhook?: McpWebhook }).webhook;
        const proxy = await createProxyServer(server, {
          tools,
          call: (toolName, args) => callUpstreamTool(client, toolName, args),
          record: (event, detail) => ledger(env).append(event, { agentId, ...detail }),
          ...(budget || contract ? callHooks(env, agentId, server.name, parseRoster(env.ROSTER).zone, budget, contract) : {})
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
