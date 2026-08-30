import {
  errorResponse,
  extractAccessToken,
  json,
  verifyAccessJwt,
  Ledger,
  type AccessConfig
} from "@operon/worker-kit";
import { DurableObject } from "cloudflare:workers";
import {
  AuditUnavailableError,
  createMcpServer,
  executeRotation,
  freshBearer,
  planRotation,
  renderOpenApi,
  renderSkill,
  runTool,
  toolPath,
  ToolInputError,
  ToolUnavailableError,
  TOOLS,
  workerNameForDir,
  type PendingRotation,
  type RotationOutcome,
  type RotationPair,
  type SecretsPort,
  type ToolAudit,
  type ToolContext
} from "@operon/ops-tools";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { securityHeaders, withSecurityHeaders } from "./headers.js";
import { csrfDenied, wsOriginDenied, wsProtocolToken } from "./guards.js";

export { Ledger };

/**
 * The ops gateway (spec 0003 §3, spec 0005): the ONE operator surface,
 * behind Cloudflare Access, verified IN-WORKER on every request. Three
 * faces over one tool registry:
 *
 *   - REST:   POST /api/v1/<tool>      (the console's data layer)
 *   - MCP:    /mcp                     (agents and CLIs; same tools)
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
  /** Per-group rotation serializer (spec 0005 §6); optional like secrets. */
  ROTATION?: DurableObjectNamespace<RotationGate>;
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

/** Downstream JSON (or text) as a value, for wrapping into tool errors. */
async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

/**
 * The per-group rotation serializer (spec 0005 §6). Durable Objects
 * serialize calls per instance (idFromName(group)), so two concurrent
 * rotations of one group run one after the other, each applying its own
 * single value to every member: the interleaving that could split a
 * group with both callers reporting success cannot happen. Values are
 * minted inside the call and never stored or returned.
 */
export class RotationGate extends DurableObject<Env> {
  async rotate(pairs: RotationPair[]): Promise<RotationOutcome & { resumed: boolean }> {
    const raw = rawCloudflareSecrets(this.env);
    if (!raw) {
      throw new Error("secrets are not configured on this gateway (CLOUDFLARE_API_TOKEN missing)");
    }
    const prefix = this.env.WORKER_NAME_PREFIX;
    // Durable recovery (spec 0005 §6): an incomplete rotation stores its
    // in-flight value plus the members still missing it, so the re-run
    // RESUMES with the same value instead of minting another and can
    // never leave the group split across values. The pending value lives
    // ONLY in this gate's storage and is deleted the moment the group
    // converges; it is the same value being written into Worker secrets,
    // not a second credential. A changed member list abandons the stale
    // plan and starts fresh.
    const stored = await this.ctx.storage.get<PendingRotation>("pending");
    const plan = planRotation(stored, pairs, freshBearer);
    const outcome = await executeRotation(plan.target, plan.value, (dir, name, value) =>
      raw.put(workerNameForDir(dir, prefix), name, value)
    );
    if (outcome.failedPairs.length === 0) {
      await this.ctx.storage.delete("pending");
    } else {
      await this.ctx.storage.put("pending", {
        value: plan.value,
        remaining: outcome.failedPairs,
        all: [...pairs]
      } satisfies PendingRotation);
    }
    // Report the group's WHOLE credential state, not just this attempt's
    // writes: on a resume, members that converged in an earlier attempt
    // already hold the pending value, and an incomplete report that
    // omits them would misstate which workers carry which bearer.
    const written = pairs
      .filter(
        pair => !outcome.failedPairs.some(f => f[0] === pair[0] && f[1] === pair[1])
      )
      .map(([dir, name]) => `${dir}/${name}`);
    return { ...outcome, written, resumed: plan.resumed };
  }
}

interface RawSecrets {
  list(script: string): Promise<string[]>;
  put(script: string, name: string, value: string): Promise<void>;
}

function rawCloudflareSecrets(env: Env): RawSecrets | undefined {
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

function secretsPort(env: Env): SecretsPort | undefined {
  const raw = rawCloudflareSecrets(env);
  if (!raw) return undefined;
  const prefix = env.WORKER_NAME_PREFIX;
  return {
    // Tools address workers by DIRECTORY name; the deployed script name
    // is directory plus the colony's prefix, mapped here once.
    list: worker => raw.list(workerNameForDir(worker, prefix)),
    put: (worker, name, value) => raw.put(workerNameForDir(worker, prefix), name, value),
    async rotateGroup(group, pairs) {
      if (!env.ROTATION) {
        throw new ToolUnavailableError("rotation gate unbound (ROTATION durable object)");
      }
      // The DO serializes per group; the value is minted inside the call.
      return env.ROTATION.get(env.ROTATION.idFromName(group)).rotate(
        pairs.map(pair => [pair[0], pair[1]] as const)
      );
    }
  };
}

function toolContext(env: Env, operator: string): ToolContext {
  const secrets = secretsPort(env);
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
    async scheduler(method, path, options) {
      const target = env.SCHEDULER as Fetcher | undefined;
      if (!target) throw new ToolUnavailableError("binding_unwired: SCHEDULER");
      if (!env.WAKE_TRIGGER_TOKEN) {
        throw new ToolUnavailableError("downstream_token_missing: SCHEDULER");
      }
      const response = await target.fetch(`https://internal${path}`, {
        method,
        headers: {
          authorization: `Bearer ${env.WAKE_TRIGGER_TOKEN}`,
          "x-operon-operator": operator,
          ...(options?.body !== undefined ? { "content-type": "application/json" } : {})
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
    async auditRecent(limit) {
      return audit(env).recent(limit);
    },
    ...(secrets ? { secrets } : {})
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
        }))
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

    // ---- the console SPA (spec 0005 §7): unmatched GETs are assets ---
    if (request.method === "GET" && env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      return withSecurityHeaders(asset, securityHeaders(url.host));
    }

    return errorResponse(404, "unknown_operator_route");
  }
} satisfies ExportedHandler<Env>;
