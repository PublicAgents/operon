import { errorResponse, json, verifyAccessRequest, Ledger, type AccessConfig } from "@operon/worker-kit";
import { downstreamPath, matchRoute, OPS_ROUTES, type OpsRoute } from "./routes.js";

export { Ledger };
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
  /** The chronicle Gatekeeper (read forwarding). */
  CHRONICLE_GK?: Fetcher;
  /** The chronicle D1, so the audit ledger mirrors centrally. */
  CHRONICLE?: D1Database;
  /** This gateway's own operator-attributed audit ledger. */
  AUDIT: DurableObjectNamespace<Ledger>;
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
      // CHRONICLE_GK, spend, vault, x: OPERATOR_API_TOKEN
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

    const operator = access.identity.email || access.identity.sub;
    const target = `https://internal${downstreamPath(match)}${match.route.downstreamMethod === "GET" ? url.search : ""}`;
    const response = await binding.fetch(target, {
      method: match.route.downstreamMethod,
      headers: {
        authorization: `Bearer ${bearer}`,
        "x-operon-operator": operator,
        ...(match.route.downstreamMethod === "POST" ? { "content-type": "application/json" } : {})
      },
      ...(body !== undefined ? { body } : {})
    });
    const text = await response.text();

    // Operator-attributed audit (spec 0003): every action this gateway
    // performs is recorded WITH the Access identity, in this gateway's
    // own ledger (mirrored to the chronicle when the D1 is bound), so a
    // decision record always says which operator made it.
    try {
      await env.AUDIT.get(env.AUDIT.idFromName("ops")).append(
        match.route.decision ? "operator_decision" : "operator_read",
        {
          operator,
          method: match.route.method,
          path: url.pathname,
          status: response.status,
          ...(match.route.decision ? { decision: true } : {})
        }
      );
    } catch (error) {
      // Audit is oversight, not the action; a ledger hiccup must not fail
      // a decision the downstream already made. Logged, never thrown.
      console.error("ops audit append failed", error);
    }

    return new Response(text, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
    });
  }
} satisfies ExportedHandler<Env>;
