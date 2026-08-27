import { errorResponse, json, verifyAccessRequest, type AccessConfig } from "@operon/worker-kit";
import { downstreamPath, matchRoute, OPS_ROUTES, type OpsRoute } from "./routes.js";

export * from "./routes.js";

/**
 * The ops gateway (spec 0003 §3): the ONE operator surface, behind
 * Cloudflare Access. Every request's Access JWT is verified IN-WORKER
 * (so a routing mistake fails closed), then forwarded to the owning
 * Gatekeeper over a private service binding, presenting the internal
 * bearer. The operator holds no chassis token; identity is the GitHub
 * SSO session Access carries.
 *
 * Step 3 removes the per-Gatekeeper public operator endpoints and the
 * bearers this forwards with; until then, this is a thin, audited,
 * Access-gated front for them, and OPERATOR_API_TOKEN stops living on
 * the operator's laptop.
 */

interface Env {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** The internal bearer each downstream still expects (removed in step 3). */
  OPERATOR_API_TOKEN?: string;
  EMAIL_SERVICE_TOKEN?: string;
  NOTIFY_TOKEN?: string;
  WAKE_TRIGGER_TOKEN?: string;
  /** Service bindings to every Gatekeeper the operator surface touches. */
  CHRONICLE?: Fetcher;
  EMAIL?: Fetcher;
  SPEND?: Fetcher;
  VAULT?: Fetcher;
  X?: Fetcher;
  TELEGRAM?: Fetcher;
  SCHEDULER?: Fetcher;
  [name: string]: unknown;
}

/** The bearer each binding's downstream endpoint currently checks. */
function bearerFor(route: OpsRoute, env: Env): string | undefined {
  switch (route.binding) {
    case "EMAIL":
      return env.EMAIL_SERVICE_TOKEN;
    case "TELEGRAM":
      return route.downstreamPath === "/ledger" ? env.NOTIFY_TOKEN : env.OPERATOR_API_TOKEN;
    case "SCHEDULER":
      return env.WAKE_TRIGGER_TOKEN;
    default:
      // chronicle, spend, vault, x: OPERATOR_API_TOKEN
      return env.OPERATOR_API_TOKEN;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Access verification, in-Worker, on every request (fail closed).
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      return errorResponse(503, "access_unconfigured");
    }
    const config: AccessConfig = { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD };
    const access = await verifyAccessRequest(request, config);
    if (!access.ok) return errorResponse(401, "access_denied", access.reason);

    if (url.pathname === "/whoami") {
      return json({ ok: true, identity: access.identity });
    }
    if (url.pathname === "/routes") {
      return json({ ok: true, routes: OPS_ROUTES.map(r => ({ method: r.method, path: r.path, decision: !!r.decision })) });
    }

    const match = matchRoute(request.method, url.pathname);
    if (!match) return errorResponse(404, "unknown_operator_route");
    const binding = env[match.route.binding] as Fetcher | undefined;
    if (!binding) return errorResponse(503, "binding_unwired", match.route.binding);
    const bearer = bearerFor(match.route, env);
    if (!bearer) return errorResponse(503, "downstream_token_missing", match.route.binding);

    // Forward over the private binding, carrying the query string and, for
    // POSTs, the body. The operator's identity is logged; downstream sees
    // the internal bearer (removed in step 3).
    const target = `https://internal${downstreamPath(match)}${url.search}`;
    const init: RequestInit = {
      method: match.route.downstreamMethod,
      headers: {
        authorization: `Bearer ${bearer}`,
        "x-operon-operator": access.identity.email || access.identity.sub,
        ...(match.route.downstreamMethod === "POST" ? { "content-type": "application/json" } : {})
      },
      ...(match.route.downstreamMethod === "POST"
        ? { body: request.method === "POST" ? await request.text() : "{}" }
        : {})
    };
    const response = await binding.fetch(target, init);
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
    });
  }
} satisfies ExportedHandler<Env>;
