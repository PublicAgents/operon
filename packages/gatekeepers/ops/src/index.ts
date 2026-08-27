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
 * Every operator operation now lives on each Gatekeeper's binding-only
 * Ops entrypoint, reached bearer-free over a service binding; the only
 * downstream bearer left is the scheduler's WAKE_TRIGGER_TOKEN (its
 * control endpoints move to bindings with the umbilical). OPERATOR_API_TOKEN
 * no longer exists anywhere.
 */

interface Env {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** The scheduler's trigger bearer: the one operator path not yet an
   * Ops entrypoint (wake/enable/disable move to bindings with the
   * umbilical). Everything else forwards bearer-free over an Ops binding. */
  WAKE_TRIGGER_TOKEN?: string;
  /** The chronicle D1, so the audit ledger mirrors centrally. */
  CHRONICLE?: D1Database;
  /** This gateway's own operator-attributed audit ledger. */
  AUDIT: DurableObjectNamespace<Ledger>;
  /** Service bindings, each targeting the Gatekeeper's binding-only Ops
   * entrypoint (no bearer); SCHEDULER is the default fetch (bearer). */
  CHRONICLE_GK?: Fetcher;
  EMAIL?: Fetcher;
  SPEND?: Fetcher;
  VAULT?: Fetcher;
  X?: Fetcher;
  TILL?: Fetcher;
  DEPLOY?: Fetcher;
  GITHUB?: Fetcher;
  PR?: Fetcher;
  TELEGRAM?: Fetcher;
  SCHEDULER?: Fetcher;
  [name: string]: unknown;
}

/**
 * The only downstream still reached with a bearer is the scheduler
 * (wake/enable/disable); every other binding targets a binding-only Ops
 * entrypoint and is called with no bearer at all.
 */
function bearerFor(route: OpsRoute, env: Env): string | undefined {
  return route.binding === "SCHEDULER" ? env.WAKE_TRIGGER_TOKEN : undefined;
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
    if (match.route.binding === "SCHEDULER" && !bearer) {
      return errorResponse(503, "downstream_token_missing", match.route.binding);
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

    const operator = access.identity.email || access.identity.sub;
    const audit = env.AUDIT.get(env.AUDIT.idFromName("ops"));

    // Operator-attributed audit (spec 0003). For DECISIONS the record
    // comes FIRST and its failure refuses the action (the chassis's
    // outbox-before-send doctrine): an unattributed money decision must
    // be impossible, and a durable intent row exists even if the result
    // row later fails. Reads audit best-effort after the fact.
    if (match.route.decision) {
      try {
        await audit.append("operator_decision", {
          operator,
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

    // The outcome row (decisions) / the read row: best-effort, since the
    // action has already durably recorded its intent (decisions) or is a
    // read whose loss costs nothing but a log line.
    try {
      await audit.append(match.route.decision ? "operator_decision_result" : "operator_read", {
        operator,
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
} satisfies ExportedHandler<Env>;
