import {
  errorResponse,
  extractAccessToken,
  json,
  verifyAccessJwt,
  Ledger,
  type AccessConfig
} from "@operon/worker-kit";
import {
  AuditUnavailableError,
  createMcpServer,
  renderOpenApi,
  renderSkill,
  runTool,
  toolPath,
  ToolInputError,
  ToolUnavailableError,
  TOOLS,
  workerNameForDir,
  type SecretsPort,
  type ToolAudit,
  type ToolContext
} from "@operon/ops-tools";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { downstreamPath, matchRoute, OPS_ROUTES, type OpsRoute } from "./routes.js";
import { securityHeaders, withSecurityHeaders } from "./headers.js";
import { csrfDenied, wsOriginDenied, wsProtocolToken } from "./guards.js";

export { Ledger };
export * from "./routes.js";

/**
 * The ops gateway (spec 0003 §3, spec 0005): the ONE operator surface,
 * behind Cloudflare Access, verified IN-WORKER on every request. Three
 * faces over one tool registry:
 *
 *   - REST:   POST /api/v1/<tool>      (the console's data layer)
 *   - MCP:    /mcp                     (agents and CLIs; same tools)
 *   - Legacy: the OPS_ROUTES table     (tail-wake, Telegram buttons;
 *                                       aliases until both migrate)
 *
 * plus /ws/* WebSocket passthroughs to the live DOs and the console SPA
 * itself as static assets on every unmatched GET. Every decision writes
 * an operator-attributed intent row BEFORE it acts and is refused if
 * that write fails.
 */

interface Env {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** The scheduler's trigger bearer: the one downstream bearer left. */
  WAKE_TRIGGER_TOKEN?: string;
  /** The chronicle D1, so the audit ledger mirrors centrally. */
  CHRONICLE?: D1Database;
  /** This gateway's own operator-attributed audit ledger. */
  AUDIT: DurableObjectNamespace<Ledger>;
  /** Secrets writes via the Cloudflare API (spec 0005 §6); optional. */
  CLOUDFLARE_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** Worker-dir to script-name prefix; the colony default. */
  WORKER_NAME_PREFIX?: string;
  /** The console SPA build (Workers static assets); optional. */
  ASSETS?: Fetcher;
  CHRONICLE_GK?: Fetcher;
  EMAIL?: Fetcher;
  SPEND?: Fetcher;
  VAULT?: Fetcher;
  X?: Fetcher;
  TILL?: Fetcher;
  DEPLOY?: Fetcher;
  GITHUB?: Fetcher;
  PR?: Fetcher;
  BROWSER?: Fetcher;
  TELEGRAM?: Fetcher;
  SCHEDULER?: Fetcher;
  [name: string]: unknown;
}

function bearerFor(route: OpsRoute, env: Env): string | undefined {
  return route.binding === "SCHEDULER" ? env.WAKE_TRIGGER_TOKEN : undefined;
}

/** Downstream JSON (or text) as a value, for wrapping into tool errors. */
async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function cloudflareSecrets(env: Env): SecretsPort | undefined {
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  if (!token || !account) return undefined;
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    async list(worker) {
      const response = await fetch(`${base}/${worker}/secrets`, { headers });
      if (!response.ok) {
        throw new ToolInputError(
          `cloudflare api ${response.status} listing secrets on ${worker}`,
          response.status === 404 ? 404 : 502
        );
      }
      const body = (await response.json()) as { result?: { name?: string }[] };
      return (body.result ?? [])
        .map(row => row.name)
        .filter((name): name is string => typeof name === "string");
    },
    async put(worker, name, value) {
      const response = await fetch(`${base}/${worker}/secrets`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ name, text: value, type: "secret_text" })
      });
      if (!response.ok) {
        // Status only: the error body could echo request content, and no
        // secret value may ever reach a log or a caller.
        throw new ToolInputError(
          `cloudflare api ${response.status} writing ${name} on ${worker}`,
          response.status === 404 ? 404 : 502
        );
      }
    }
  };
}

function toolContext(env: Env, operator: string): ToolContext {
  const prefix = env.WORKER_NAME_PREFIX;
  const secrets = cloudflareSecrets(env);
  return {
    operator,
    async ops(binding, method, path, options) {
      const target = env[binding] as Fetcher | undefined;
      if (!target) throw new ToolUnavailableError(`binding_unwired: ${binding}`);
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(options?.query ?? {})) {
        if (value !== undefined) query.set(key, value);
      }
      const search = query.size > 0 ? `?${query.toString()}` : "";
      const response = await target.fetch(`https://internal${path}${search}`, {
        method,
        headers: {
          "x-operon-operator": operator,
          ...(method === "POST" ? { "content-type": "application/json" } : {})
        },
        ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {})
      });
      const payload = await responsePayload(response);
      if (!response.ok) {
        throw new ToolInputError(
          `downstream ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`,
          response.status,
          payload
        );
      }
      return payload;
    },
    async scheduler(method, path) {
      const target = env.SCHEDULER as Fetcher | undefined;
      if (!target) throw new ToolUnavailableError("binding_unwired: SCHEDULER");
      if (!env.WAKE_TRIGGER_TOKEN) {
        throw new ToolUnavailableError("downstream_token_missing: SCHEDULER");
      }
      const response = await target.fetch(`https://internal${path}`, {
        method,
        headers: {
          authorization: `Bearer ${env.WAKE_TRIGGER_TOKEN}`,
          "x-operon-operator": operator
        }
      });
      const payload = await responsePayload(response);
      if (!response.ok) {
        throw new ToolInputError(
          `downstream ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`,
          response.status,
          payload
        );
      }
      return payload;
    },
    async auditRecent(limit) {
      return audit(env).recent(limit);
    },
    ...(secrets
      ? {
          // Tools address workers by DIRECTORY name; the deployed script
          // name is directory plus the colony's prefix, mapped here once.
          secrets: {
            list: worker => secrets.list(workerNameForDir(worker, prefix)),
            put: (worker, name, value) =>
              secrets.put(workerNameForDir(worker, prefix), name, value)
          }
        }
      : {})
  };
}

function audit(env: Env) {
  return env.AUDIT.get(env.AUDIT.idFromName("ops"));
}

function toolAudit(env: Env, operator: string, via: string): ToolAudit {
  return {
    async intent(tool, summary) {
      await audit(env).append("operator_decision", { operator, tool, via, body: summary });
    },
    async finish(tool, decision, ok, status) {
      try {
        await audit(env).append(decision ? "operator_decision_result" : "operator_read", {
          operator,
          tool,
          via,
          ok,
          status
        });
      } catch (error) {
        console.error("ops audit append failed", error);
      }
    }
  };
}

function toolErrorResponse(error: unknown): Response {
  if (error instanceof ToolInputError) {
    return json(
      error.payload !== undefined ? error.payload : { error: error.message },
      error.status
    );
  }
  if (error instanceof ToolUnavailableError) {
    return errorResponse(503, "unavailable", error.message);
  }
  if (error instanceof AuditUnavailableError) {
    return errorResponse(503, "audit_unavailable", error.message);
  }
  throw error;
}

const WS_ROUTES: { pattern: RegExp; binding: string; downstream: (tail: string) => string }[] = [
  {
    pattern: /^\/ws\/wake-log\/([0-9a-f-]{8,64})$/,
    binding: "CHRONICLE_GK",
    downstream: tail => `/ws/wake-log/${tail}`
  },
  { pattern: /^\/ws\/channel$/, binding: "TELEGRAM", downstream: () => "/ws/channel" }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Access verification, in-Worker, on every request (fail closed).
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      return errorResponse(503, "access_unconfigured");
    }
    const config: AccessConfig = { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD };
    // Header or cookie, plus (for WebSocket upgrades only) the
    // subprotocol carrier: the WHATWG WebSocket API cannot set headers.
    const token =
      extractAccessToken(request) ??
      (url.pathname.startsWith("/ws/") ? wsProtocolToken(request) : null);
    const access = token
      ? await verifyAccessJwt(token, config)
      : ({ ok: false, reason: "no_token" } as const);
    if (!access.ok) return errorResponse(401, "access_denied", access.reason);
    const operator =
      access.identity.email || access.identity.commonName || access.identity.sub;

    if (url.pathname === "/whoami") {
      return json({ ok: true, identity: access.identity });
    }
    if (url.pathname === "/routes") {
      return json({
        ok: true,
        tools: TOOLS.map(tool => ({
          name: tool.name,
          path: toolPath(tool.name),
          decision: tool.decision
        })),
        legacy: OPS_ROUTES.map(r => ({ method: r.method, path: r.path, decision: !!r.decision }))
      });
    }
    if (url.pathname === "/openapi.json" && request.method === "GET") {
      return json(renderOpenApi(url.origin));
    }
    if (url.pathname === "/skill.md" && request.method === "GET") {
      return new Response(renderSkill(url.origin), {
        headers: { "content-type": "text/markdown; charset=utf-8" }
      });
    }

    // ---- WebSocket passthrough to the live DOs (spec 0005 §4) --------
    for (const ws of WS_ROUTES) {
      const match = ws.pattern.exec(url.pathname);
      if (!match) continue;
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return errorResponse(426, "upgrade_required");
      }
      const denied = wsOriginDenied(request, url);
      if (denied) return denied;
      const binding = env[ws.binding] as Fetcher | undefined;
      if (!binding) return errorResponse(503, "binding_unwired", ws.binding);
      try {
        await audit(env).append("operator_read", {
          operator,
          tool: "ws",
          via: "ws",
          path: url.pathname
        });
      } catch (error) {
        console.error("ops audit append failed", error);
      }
      // The raw request forwards so the Upgrade negotiation passes
      // through the binding untouched (the umbilical's CDP precedent).
      return binding.fetch(
        new Request(`https://internal${ws.downstream(match[1] ?? "")}`, request)
      );
    }

    // ---- the registry: REST (spec 0005 §2) ---------------------------
    if (url.pathname.startsWith("/api/v1/")) {
      const tool = TOOLS.find(candidate => toolPath(candidate.name) === url.pathname);
      if (!tool) return errorResponse(404, "unknown_tool");
      if (request.method !== "POST") return errorResponse(405, "post_only");
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return errorResponse(415, "json_only");
      }
      const denied = csrfDenied(request, url);
      if (denied) return denied;
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        return errorResponse(400, "malformed_json");
      }
      try {
        const value = await runTool(
          tool,
          input,
          toolContext(env, operator),
          toolAudit(env, operator, "rest")
        );
        return json(value);
      } catch (error) {
        return toolErrorResponse(error);
      }
    }

    // ---- the registry: MCP (same tools, fresh server per request) ----
    if (url.pathname === "/mcp") {
      if (request.method === "POST") {
        const denied = csrfDenied(request, url);
        if (denied) return denied;
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      const server = createMcpServer(
        toolContext(env, operator),
        toolAudit(env, operator, "mcp"),
        url.origin
      );
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await server.close();
      }
    }

    // ---- legacy alias table (until tail-wake + Telegram migrate) -----
    const match = matchRoute(request.method, url.pathname);
    if (match) {
      const binding = env[match.route.binding] as Fetcher | undefined;
      if (!binding) return errorResponse(503, "binding_unwired", match.route.binding);
      const bearer = bearerFor(match.route, env);
      if (match.route.binding === "SCHEDULER" && !bearer) {
        return errorResponse(503, "downstream_token_missing", match.route.binding);
      }
      if (request.method === "POST") {
        const denied = csrfDenied(request, url);
        if (denied) return denied;
      }

      // Body for the downstream call. A POST operator request forwards its
      // body verbatim; a GET whose downstream is a POST (e.g. email/outbox,
      // which reads {agentId} from a body) carries the query params AS the
      // body, so ?agentId=promoter reaches the handler.
      let body: string | undefined;
      if (match.route.downstreamMethod === "POST") {
        body =
          request.method === "POST"
            ? await request.text()
            : JSON.stringify(Object.fromEntries(url.searchParams));
      }

      // Operator-attributed audit (spec 0003). For DECISIONS the record
      // comes FIRST and its failure refuses the action; reads audit
      // best-effort after the fact.
      if (match.route.decision) {
        try {
          await audit(env).append("operator_decision", {
            operator,
            via: "legacy",
            method: match.route.method,
            path: url.pathname,
            body: (body ?? "").slice(0, 500)
          });
        } catch (error) {
          console.error("ops audit unavailable; refusing decision", error);
          return errorResponse(503, "audit_unavailable", "decision refused: it could not be attributed");
        }
      }

      const target = `https://internal${downstreamPath(match)}${match.route.downstreamMethod === "GET" ? url.search : ""}`;
      const response = await binding.fetch(target, {
        method: match.route.downstreamMethod,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          "x-operon-operator": operator,
          ...(match.route.downstreamMethod === "POST" ? { "content-type": "application/json" } : {})
        },
        ...(body !== undefined ? { body } : {})
      });
      const text = await response.text();

      try {
        await audit(env).append(match.route.decision ? "operator_decision_result" : "operator_read", {
          operator,
          via: "legacy",
          method: match.route.method,
          path: url.pathname,
          status: response.status
        });
      } catch (error) {
        console.error("ops audit append failed", error);
      }

      return new Response(text, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
      });
    }

    // ---- the console SPA (spec 0005 §7): unmatched GETs are assets ---
    if (request.method === "GET" && env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      return withSecurityHeaders(asset, securityHeaders(url.host));
    }

    return errorResponse(404, "unknown_operator_route");
  }
} satisfies ExportedHandler<Env>;
